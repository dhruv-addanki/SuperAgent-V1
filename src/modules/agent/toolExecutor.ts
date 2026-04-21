import {
  PendingActionStatus,
  type Conversation,
  type PendingAction,
  type PrismaClient,
  type User
} from "@prisma/client";
import { env } from "../../config/env";
import { AuditService } from "../audit/auditService";
import { CalendarService } from "../google/calendarService";
import { DocsService } from "../google/docsService";
import { DriveService } from "../google/driveService";
import { GmailService } from "../google/gmailService";
import { GoogleTokenService } from "../google/tokenService";
import {
  createPendingAction,
  expectedConfirmationForPayload,
  getApprovalDecision,
  matchesPositiveConfirmation,
  userClearlyRequestedEmailSend,
  type PendingToolPayload
} from "./approvalPolicy";
import {
  isToolName,
  isWriteTool,
  toolInputSchemas,
  type ToolName
} from "../../schemas/toolSchemas";
import { serializeError, userMessageForError } from "../../lib/errors";
import { formatForUser } from "../../lib/time";

export interface ToolExecutionContext {
  user: User;
  conversation: Conversation;
  latestUserMessage: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  userMessage?: string;
  approvalRequired?: boolean;
}

export class ToolExecutor {
  private readonly audit: AuditService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokenService: GoogleTokenService
  ) {
    this.audit = new AuditService(prisma);
  }

  async executeToolCall(
    toolNameValue: string,
    rawInput: unknown,
    context: ToolExecutionContext,
    options: { force?: boolean } = {}
  ): Promise<ToolExecutionResult> {
    if (!isToolName(toolNameValue)) {
      return {
        ok: false,
        error: `Unknown tool: ${toolNameValue}`,
        userMessage: "I could not use that tool."
      };
    }

    const toolName = toolNameValue;
    const parsedInput = this.validateInput(toolName, rawInput);

    if (env.GOOGLE_READ_ONLY_MODE && isWriteTool(toolName)) {
      await this.audit.log({
        userId: context.user.id,
        actionType: "write_blocked_read_only",
        toolName,
        requestPayload: parsedInput,
        status: "blocked"
      });
      return {
        ok: false,
        error: "WRITE_DISABLED",
        userMessage: "Write actions are disabled in read-only mode."
      };
    }

    if (!options.force) {
      const approval = getApprovalDecision(toolName, parsedInput, context.latestUserMessage);
      if (approval.requiresApproval && approval.confirmationKeyword) {
        await createPendingAction(this.prisma, {
          userId: context.user.id,
          conversationId: context.conversation.id,
          actionType: toolName,
          payload: {
            toolName,
            input: parsedInput,
            confirmationKeyword: approval.confirmationKeyword,
            summary: approval.reason
          }
        });

        await this.audit.log({
          userId: context.user.id,
          actionType: approval.reason ?? "pending_approval",
          toolName,
          requestPayload: parsedInput,
          status: "pending"
        });

        return {
          ok: true,
          approvalRequired: true,
          data: { pending: true, toolName },
          userMessage: approval.confirmationMessage
        };
      }
    }

    return this.executeValidatedTool(toolName, parsedInput, context);
  }

  async executePendingAction(
    pendingAction: PendingAction,
    context: ToolExecutionContext,
    intent: "SEND" | "CONFIRM"
  ): Promise<ToolExecutionResult> {
    const expected = expectedConfirmationForPayload(pendingAction.payload);
    if (!matchesPositiveConfirmation(intent, expected)) {
      return {
        ok: false,
        userMessage: "Reply yes to approve this action, or CANCEL to cancel it."
      };
    }

    const payload = pendingAction.payload as unknown as PendingToolPayload;
    if (!payload.toolName || !isToolName(payload.toolName)) {
      await this.prisma.pendingAction.update({
        where: { id: pendingAction.id },
        data: { status: PendingActionStatus.FAILED }
      });
      return { ok: false, userMessage: "I could not read that pending action." };
    }

    await this.prisma.pendingAction.update({
      where: { id: pendingAction.id },
      data: { status: PendingActionStatus.APPROVED }
    });

    const result = await this.executeToolCall(payload.toolName, payload.input, context, {
      force: true
    });

    await this.prisma.pendingAction.update({
      where: { id: pendingAction.id },
      data: {
        status: result.ok ? PendingActionStatus.EXECUTED : PendingActionStatus.FAILED
      }
    });

    return result;
  }

  private validateInput(toolName: ToolName, rawInput: unknown): any {
    return toolInputSchemas[toolName].parse(rawInput);
  }

  private async executeValidatedTool(
    toolName: ToolName,
    input: any,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    try {
      const auth = await this.tokenService.getOAuthClientForUser(context.user, {
        requiredScopes:
          toolName === "calendar_list_calendars"
            ? ["https://www.googleapis.com/auth/calendar.calendarlist.readonly"]
            : [],
        reconnectReason:
          "Reconnect your Google account to access all of your calendars by name"
      });

      if (toolName === "gmail_search_threads") {
        const service = new GmailService(auth);
        const data = await service.searchThreads(input.query, input.maxResults);
        return { ok: true, data };
      }

      if (toolName === "gmail_read_thread") {
        const service = new GmailService(auth);
        const data = await service.readThread(input.threadId);
        return { ok: true, data };
      }

      if (toolName === "gmail_create_draft") {
        const service = new GmailService(auth);
        const data = await service.createDraft(input);
        await this.audit.log({
          userId: context.user.id,
          actionType: "gmail_create_draft",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "success"
        });

        const explicitSendRequest = userClearlyRequestedEmailSend(context.latestUserMessage);
        if (!explicitSendRequest) {
          await createPendingAction(this.prisma, {
            userId: context.user.id,
            conversationId: context.conversation.id,
            actionType: "gmail_send_draft",
            payload: {
              toolName: "gmail_send_draft",
              input: { draftId: data.draftId },
              confirmationKeyword: "CONFIRM",
              summary: data.summary,
              context: {
                to: data.to,
                subject: data.subject,
                body: input.body
              }
            }
          });
        }

        return {
          ok: true,
          data,
          userMessage: explicitSendRequest ? undefined : "Draft ready. Want me to send it?"
        };
      }

      if (toolName === "gmail_send_draft") {
        const service = new GmailService(auth);
        const data = await service.sendDraft(input.draftId);
        await this.audit.log({
          userId: context.user.id,
          actionType: "gmail_send_draft",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return { ok: true, data, userMessage: "Sent the draft." };
      }

      if (toolName === "calendar_list_calendars") {
        const service = new CalendarService(auth);
        const data = await service.listCalendars();
        return { ok: true, data };
      }

      if (toolName === "calendar_list_events") {
        const service = new CalendarService(auth);
        const data = await service.listEvents(input);
        return { ok: true, data };
      }

      if (toolName === "calendar_create_event") {
        const service = new CalendarService(auth);
        const data = await service.createEvent(input);
        await this.audit.log({
          userId: context.user.id,
          actionType: "calendar_create_event",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return {
          ok: true,
          data,
          userMessage: `Booked: ${data.title}${data.start ? ` at ${formatForUser(data.start, context.user.timezone)}` : ""}.`
        };
      }

      if (toolName === "calendar_update_event") {
        const service = new CalendarService(auth);
        const data = await service.updateEvent(input);
        await this.audit.log({
          userId: context.user.id,
          actionType: "calendar_update_event",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return {
          ok: true,
          data,
          userMessage: `Updated: ${data.title}${data.start ? ` at ${formatForUser(data.start, context.user.timezone)}` : ""}.`
        };
      }

      if (toolName === "calendar_delete_event") {
        const service = new CalendarService(auth);
        const data = await service.deleteEvent(input);
        await this.audit.log({
          userId: context.user.id,
          actionType: "calendar_delete_event",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return { ok: true, data, userMessage: data.summary };
      }

      if (toolName === "drive_search_files") {
        const service = new DriveService(auth);
        const data = await service.searchFiles(input);
        return { ok: true, data };
      }

      if (toolName === "drive_read_file_metadata") {
        const service = new DriveService(auth);
        const data = await service.readFileMetadata(input.fileId);
        return { ok: true, data };
      }

      if (toolName === "docs_create_document") {
        const service = new DocsService(auth);
        const data = await service.createDocument(input);
        await this.audit.log({
          userId: context.user.id,
          actionType: "docs_create_document",
          toolName,
          requestPayload: input,
          responsePayload: data,
          status: "executed"
        });
        return { ok: true, data, userMessage: `Created: ${data.title}\n${data.url}` };
      }

      return { ok: false, error: `Unhandled tool: ${toolName}` };
    } catch (error) {
      if (isWriteTool(toolName)) {
        await this.audit.log({
          userId: context.user.id,
          actionType: toolName,
          toolName,
          requestPayload: input,
          status: "failed",
          error: serializeError(error)
        });
      }

      return {
        ok: false,
        error: serializeError(error),
        userMessage: userMessageForError(error)
      };
    }
  }
}
