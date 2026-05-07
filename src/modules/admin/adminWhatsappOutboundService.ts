import crypto from "node:crypto";
import { PendingActionStatus, MessageRole, type PrismaClient, type User } from "@prisma/client";
import { subHours } from "date-fns";
import { env } from "../../config/env";
import { AuditService } from "../audit/auditService";
import { UserFacingError, serializeError } from "../../lib/errors";
import type { ResponsesClient } from "../../lib/openaiClient";
import { extractOutputText } from "../agent/responseLoop";
import { normalizeAssistantMessageForUser } from "../../lib/messageText";
import { pendingActionExpiry } from "../../lib/time";
import { getOrCreateWhatsAppConversation, persistMessage } from "../agent/conversationState";
import {
  buildAssistantMessageRawPayload,
  type AssistantDeliveryMetadata
} from "../agent/asanaMessageRefs";
import {
  buildConversationContext,
  formatConversationContextForPrompt
} from "../agent/conversationContext";
import { ShortTermMemory } from "../memory/shortTermMemory";
import { LongTermMemory } from "../memory/longTermMemory";
import { WhatsAppService } from "../whatsapp/whatsappService";

export type AdminOutboundMode = "exact" | "draft" | "auto";

export interface SubmitAdminOutboundInput {
  phone: string;
  mode?: AdminOutboundMode;
  message?: string;
  instruction?: string;
  request?: string;
}

export interface ConfirmAdminOutboundInput {
  approvalCode: string;
}

export interface CancelAdminOutboundInput {
  approvalCode: string;
}

export interface AdminWhatsAppOutboundServiceOptions {
  now?: () => Date;
  templateName?: string;
  templateLanguage?: string;
}

export type AdminOutboundResult =
  | {
      status: "sent";
      mode: "exact" | "confirmed";
      phone: string;
      message: string;
      delivery: AdminOutboundDelivery;
    }
  | {
      status: "pending";
      mode: "draft";
      phone: string;
      preview: string;
      approvalCode: string;
      expiresAt: Date;
    };

export interface AdminOutboundDelivery {
  channel: "text" | "template";
  messageId?: string;
}

interface TargetConversation {
  user: User;
  conversationId: string;
}

interface AdminOutboundPendingPayload {
  kind: "admin_whatsapp_outbound";
  phone: string;
  message: string;
  instruction: string;
  createdAt: string;
}

export class AdminWhatsAppOutboundService {
  private readonly audit: AuditService;
  private readonly shortTermMemory: ShortTermMemory;
  private readonly longTermMemory: LongTermMemory;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly responsesClient: ResponsesClient,
    private readonly whatsappService: WhatsAppService,
    private readonly options: AdminWhatsAppOutboundServiceOptions = {}
  ) {
    this.audit = new AuditService(prisma);
    this.shortTermMemory = new ShortTermMemory(prisma);
    this.longTermMemory = new LongTermMemory(prisma);
  }

  async submit(input: SubmitAdminOutboundInput): Promise<AdminOutboundResult> {
    const phone = normalizePhone(input.phone);
    const mode = input.mode ?? "auto";
    const exactRequested = wantsExactOutbound(input, mode);
    const exactMessage = exactOutboundMessage(input, mode);

    if (exactRequested && !exactMessage) {
      throw new UserFacingError(
        "Missing exact outbound message",
        "ADMIN_OUTBOUND_MISSING_MESSAGE",
        "Provide the exact WhatsApp message body to send."
      );
    }

    if (exactMessage) {
      const target = await this.resolveTarget(phone);
      try {
        const delivery = await this.deliver({
          userId: target.user.id,
          conversationId: target.conversationId,
          phone,
          message: exactMessage
        });
        await this.audit.log({
          userId: target.user.id,
          actionType: "admin_whatsapp_outbound_exact",
          toolName: "admin_whatsapp_outbound",
          requestPayload: scrubSubmitInput(input),
          responsePayload: { phone, delivery },
          status: "executed"
        });
        return {
          status: "sent",
          mode: "exact",
          phone,
          message: normalizeAssistantMessageForUser(exactMessage),
          delivery
        };
      } catch (error) {
        await this.logFailure(target.user.id, "admin_whatsapp_outbound_exact", input, error);
        throw error;
      }
    }

    const instruction = draftInstruction(input);
    if (!instruction) {
      throw new UserFacingError(
        "Missing outbound instruction",
        "ADMIN_OUTBOUND_MISSING_INSTRUCTION",
        "Provide a message for exact mode, or an instruction/request for draft mode."
      );
    }

    const target = await this.resolveTarget(phone);
    try {
      const preview = await this.draftMessage(target.user, target.conversationId, instruction);
      const pending = await this.prisma.pendingAction.create({
        data: {
          userId: target.user.id,
          conversationId: target.conversationId,
          actionType: "admin_whatsapp_outbound",
          payload: {
            kind: "admin_whatsapp_outbound",
            phone,
            message: preview,
            instruction,
            createdAt: this.now().toISOString()
          } as any,
          approvalCode: crypto.randomUUID(),
          expiresAt: pendingActionExpiry(this.now())
        }
      });

      await this.audit.log({
        userId: target.user.id,
        actionType: "admin_whatsapp_outbound_draft",
        toolName: "admin_whatsapp_outbound",
        requestPayload: scrubSubmitInput(input),
        responsePayload: {
          phone,
          preview,
          approvalCode: pending.approvalCode,
          expiresAt: pending.expiresAt
        },
        status: "pending"
      });

      return {
        status: "pending",
        mode: "draft",
        phone,
        preview,
        approvalCode: pending.approvalCode,
        expiresAt: pending.expiresAt
      };
    } catch (error) {
      await this.logFailure(target.user.id, "admin_whatsapp_outbound_draft", input, error);
      throw error;
    }
  }

  async confirm(input: ConfirmAdminOutboundInput): Promise<AdminOutboundResult> {
    const pending = await this.prisma.pendingAction.findUnique({
      where: { approvalCode: input.approvalCode }
    });

    if (!pending) {
      throw new UserFacingError(
        "Pending outbound message not found",
        "ADMIN_OUTBOUND_NOT_FOUND",
        "I couldn't find that pending outbound message."
      );
    }

    if (pending.actionType !== "admin_whatsapp_outbound") {
      throw new UserFacingError(
        "Pending action is not an outbound message",
        "ADMIN_OUTBOUND_WRONG_ACTION",
        "That confirmation code is not for an admin WhatsApp outbound message."
      );
    }

    if (pending.status !== PendingActionStatus.PENDING) {
      throw new UserFacingError(
        "Pending outbound message is no longer pending",
        "ADMIN_OUTBOUND_NOT_PENDING",
        "That outbound message was already handled or cancelled."
      );
    }

    if (pending.expiresAt <= this.now()) {
      await this.prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: PendingActionStatus.EXPIRED }
      });
      throw new UserFacingError(
        "Pending outbound message expired",
        "ADMIN_OUTBOUND_EXPIRED",
        "That outbound message confirmation expired. Create a new draft and confirm that one."
      );
    }

    const payload = parsePendingPayload(pending.payload);

    await this.prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: PendingActionStatus.APPROVED }
    });

    try {
      const delivery = await this.deliver({
        userId: pending.userId,
        conversationId: pending.conversationId,
        phone: payload.phone,
        message: payload.message
      });
      await this.prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: PendingActionStatus.EXECUTED }
      });
      await this.audit.log({
        userId: pending.userId,
        actionType: "admin_whatsapp_outbound_confirm",
        toolName: "admin_whatsapp_outbound",
        requestPayload: { approvalCode: input.approvalCode },
        responsePayload: { phone: payload.phone, delivery },
        status: "executed"
      });
      return {
        status: "sent",
        mode: "confirmed",
        phone: payload.phone,
        message: payload.message,
        delivery
      };
    } catch (error) {
      await this.prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: PendingActionStatus.FAILED }
      });
      await this.audit.log({
        userId: pending.userId,
        actionType: "admin_whatsapp_outbound_confirm",
        toolName: "admin_whatsapp_outbound",
        requestPayload: { approvalCode: input.approvalCode },
        status: "failed",
        error
      });
      throw error;
    }
  }

  async cancel(
    input: CancelAdminOutboundInput
  ): Promise<{ status: "cancelled"; approvalCode: string }> {
    const pending = await this.prisma.pendingAction.findUnique({
      where: { approvalCode: input.approvalCode }
    });

    if (!pending || pending.actionType !== "admin_whatsapp_outbound") {
      throw new UserFacingError(
        "Pending outbound message not found",
        "ADMIN_OUTBOUND_NOT_FOUND",
        "I couldn't find that pending outbound message."
      );
    }

    if (pending.status !== PendingActionStatus.PENDING) {
      throw new UserFacingError(
        "Pending outbound message is no longer pending",
        "ADMIN_OUTBOUND_NOT_PENDING",
        "That outbound message was already handled or cancelled."
      );
    }

    await this.prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: PendingActionStatus.CANCELLED }
    });
    await this.audit.log({
      userId: pending.userId,
      actionType: "admin_whatsapp_outbound_cancel",
      toolName: "admin_whatsapp_outbound",
      requestPayload: { approvalCode: input.approvalCode },
      status: "executed"
    });
    return { status: "cancelled", approvalCode: input.approvalCode };
  }

  private async resolveTarget(phone: string): Promise<TargetConversation> {
    const user = await this.prisma.user.upsert({
      where: { whatsappPhone: phone },
      update: {},
      create: { whatsappPhone: phone }
    });
    const conversation = await getOrCreateWhatsAppConversation(this.prisma, user.id);
    return { user, conversationId: conversation.id };
  }

  private async draftMessage(
    user: User,
    conversationId: string,
    instruction: string
  ): Promise<string> {
    const history = await this.shortTermMemory.loadConversationHistory(conversationId, 12);
    const memoryEntries = await this.longTermMemory.getRecentEntriesForContext(user.id, 10);
    const conversationContext = buildConversationContext({
      latestUserMessage: instruction,
      memoryEntries,
      pendingAction: null,
      pendingActionSummary: "No pending actions.",
      userProfile: [`Phone: ${user.whatsappPhone}`, `Timezone: ${user.timezone}`]
    });
    const response = await this.responsesClient.createResponse({
      model: env.OPENAI_MODEL,
      instructions: [
        "You draft outbound WhatsApp messages from SuperAgent to the user on behalf of an admin operator.",
        "Return only the message body that should be previewed to the admin.",
        "Do not claim the message was sent. Do not include quotes, labels, approval text, or alternatives.",
        "Keep the message concise, useful, and natural for WhatsApp."
      ].join("\n"),
      tools: [],
      input: [
        {
          role: "user",
          content: [
            "Admin instruction:",
            instruction,
            "",
            "Structured user context:",
            formatConversationContextForPrompt(conversationContext),
            "",
            "Recent WhatsApp conversation:",
            formatRecentHistory(history)
          ].join("\n")
        }
      ],
      tool_choice: "auto"
    });
    const draft = normalizeAssistantMessageForUser(extractOutputText(response));
    if (!draft) {
      throw new UserFacingError(
        "Empty outbound draft",
        "ADMIN_OUTBOUND_EMPTY_DRAFT",
        "I couldn't draft a WhatsApp message from that instruction."
      );
    }
    return draft;
  }

  private async deliver(input: {
    userId: string;
    conversationId: string;
    phone: string;
    message: string;
  }): Promise<AdminOutboundDelivery> {
    const safeMessage = normalizeAssistantMessageForUser(input.message);
    if (await this.hasRecentInboundMessage(input.userId)) {
      const result = await this.whatsappService.sendTextMessage(input.phone, safeMessage);
      const delivery: AssistantDeliveryMetadata = {
        channel: "text",
        ...(result.messageId ? { messageId: result.messageId } : {})
      };
      await this.persistDeliveredMessage(input.conversationId, safeMessage, delivery);
      return delivery;
    }

    const templateName = this.options.templateName ?? env.WHATSAPP_AUTOMATION_TEMPLATE_NAME;
    const templateLanguage =
      this.options.templateLanguage ?? env.WHATSAPP_AUTOMATION_TEMPLATE_LANGUAGE;
    if (!templateName) {
      throw new UserFacingError(
        "WhatsApp template required",
        "WHATSAPP_TEMPLATE_REQUIRED",
        "WhatsApp needs an approved template to send admin outbound messages outside the 24-hour window."
      );
    }

    const result = await this.whatsappService.sendTemplateMessage({
      to: input.phone,
      templateName,
      languageCode: templateLanguage,
      bodyParameters: [safeMessage]
    });
    const delivery: AssistantDeliveryMetadata = {
      channel: "template",
      ...(result.messageId ? { messageId: result.messageId } : {})
    };
    await this.persistDeliveredMessage(input.conversationId, safeMessage, delivery);
    return delivery;
  }

  private async persistDeliveredMessage(
    conversationId: string,
    content: string,
    delivery: AssistantDeliveryMetadata
  ): Promise<void> {
    await persistMessage(this.prisma, {
      conversationId,
      role: MessageRole.ASSISTANT,
      content,
      rawPayload: buildAssistantMessageRawPayload({
        source: "admin_outbound",
        delivery
      })
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: this.now() }
    });
  }

  private async hasRecentInboundMessage(userId: string): Promise<boolean> {
    const recentInbound = await this.prisma.message.findFirst({
      where: {
        role: MessageRole.USER,
        createdAt: { gte: subHours(this.now(), 24) },
        conversation: {
          userId
        }
      },
      orderBy: { createdAt: "desc" }
    });
    return Boolean(recentInbound);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async logFailure(
    userId: string,
    actionType: string,
    input: SubmitAdminOutboundInput,
    error: unknown
  ): Promise<void> {
    await this.audit.log({
      userId,
      actionType,
      toolName: "admin_whatsapp_outbound",
      requestPayload: scrubSubmitInput(input),
      status: "failed",
      error: serializeError(error)
    });
  }
}

function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
}

function exactOutboundMessage(
  input: SubmitAdminOutboundInput,
  mode: AdminOutboundMode
): string | null {
  if (mode === "exact") {
    return (
      input.message?.trim() ||
      extractExactPayload(input.request) ||
      extractExactPayload(input.instruction)
    );
  }

  if (mode !== "auto") return null;

  const controlText = [input.request, input.instruction, input.message].filter(Boolean).join("\n");
  if (!isExactSendRequest(controlText)) return null;
  return input.message?.trim() || extractExactPayload(controlText);
}

function wantsExactOutbound(input: SubmitAdminOutboundInput, mode: AdminOutboundMode): boolean {
  if (mode === "exact") return true;
  if (mode !== "auto") return false;
  return isExactSendRequest(
    [input.request, input.instruction, input.message].filter(Boolean).join("\n")
  );
}

function isExactSendRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\bsend\s+(?:exactly|verbatim|word for word)\b/.test(normalized) ||
    /\bexact\s+message\b/.test(normalized) ||
    /\bthis exact message\b/.test(normalized)
  );
}

function extractExactPayload(text: string | undefined): string | null {
  if (!text) return null;
  const patterns = [
    /\b(?:send exactly this|send this exact message|exact message|send verbatim|send word for word)\s*:?\s*([\s\S]+)$/i,
    /\bmessage exactly this\s*:?\s*([\s\S]+)$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const payload = stripWrappingQuotes(match?.[1]?.trim() ?? "");
    if (payload) return payload;
  }
  return null;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^["'“”]+|["'“”]+$/g, "").trim();
}

function draftInstruction(input: SubmitAdminOutboundInput): string | null {
  return input.instruction?.trim() || input.request?.trim() || input.message?.trim() || null;
}

function scrubSubmitInput(input: SubmitAdminOutboundInput): Record<string, unknown> {
  return {
    phone: normalizePhone(input.phone),
    mode: input.mode ?? "auto",
    hasMessage: Boolean(input.message?.trim()),
    instruction: input.instruction,
    request: input.request
  };
}

function parsePendingPayload(payload: unknown): AdminOutboundPendingPayload {
  if (!payload || typeof payload !== "object") {
    throw new UserFacingError(
      "Invalid pending outbound payload",
      "ADMIN_OUTBOUND_INVALID_PAYLOAD",
      "I couldn't read that pending outbound message."
    );
  }
  const record = payload as Partial<AdminOutboundPendingPayload>;
  if (
    record.kind !== "admin_whatsapp_outbound" ||
    typeof record.phone !== "string" ||
    typeof record.message !== "string"
  ) {
    throw new UserFacingError(
      "Invalid pending outbound payload",
      "ADMIN_OUTBOUND_INVALID_PAYLOAD",
      "I couldn't read that pending outbound message."
    );
  }
  return {
    kind: "admin_whatsapp_outbound",
    phone: normalizePhone(record.phone),
    message: normalizeAssistantMessageForUser(record.message),
    instruction: typeof record.instruction === "string" ? record.instruction : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : ""
  };
}

function formatRecentHistory(history: Array<Record<string, unknown>>): string {
  if (!history.length) return "No recent WhatsApp conversation.";
  return history
    .slice(-12)
    .map((item) => `${String(item.role ?? "message")}: ${String(item.content ?? "")}`)
    .join("\n");
}
