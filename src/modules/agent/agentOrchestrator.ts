import {
  MessageRole,
  PendingActionStatus,
  type Conversation,
  type PrismaClient,
  type User
} from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { ResponsesClient } from "../../lib/openaiClient";
import { userMessageForError } from "../../lib/errors";
import { WhatsAppService } from "../whatsapp/whatsappService";
import { AsanaTokenService } from "../asana/tokenService";
import { GoogleTokenService } from "../google/tokenService";
import { LongTermMemory } from "../memory/longTermMemory";
import { ShortTermMemory } from "../memory/shortTermMemory";
import {
  buildPendingActionContext,
  expectedConfirmationForPayload,
  matchesPositiveConfirmation,
  parseConfirmationIntent,
  resolvePendingActionFromConversation
} from "./approvalPolicy";
import { getOrCreateWhatsAppConversation, persistMessage } from "./conversationState";
import { buildSystemPrompt } from "./systemPrompt";
import { ToolExecutor } from "./toolExecutor";
import { getAvailableToolDefinitions } from "./toolRegistry";
import { runResponseLoop } from "./responseLoop";
import {
  calendarOverviewWindow,
  formatCalendarOverview,
  matchGenericCalendarOverviewRequest
} from "./calendarReadShortcut";
import type { CalendarEventSummary } from "../google/googleTypes";

export interface InboundWhatsAppTextInput {
  from: string;
  text: string;
  messageId?: string;
  rawPayload?: unknown;
}

export class AgentOrchestrator {
  private readonly toolExecutor: ToolExecutor;
  private readonly shortTermMemory: ShortTermMemory;
  private readonly longTermMemory: LongTermMemory;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly responsesClient: ResponsesClient,
    private readonly whatsappService: WhatsAppService
  ) {
    const googleTokenService = new GoogleTokenService(prisma);
    const asanaTokenService = new AsanaTokenService(prisma);
    this.toolExecutor = new ToolExecutor(prisma, googleTokenService, asanaTokenService);
    this.shortTermMemory = new ShortTermMemory(prisma);
    this.longTermMemory = new LongTermMemory(prisma);
  }

  async processInboundWhatsAppText(input: InboundWhatsAppTextInput): Promise<void> {
    const phone = normalizePhone(input.from);
    const user = await this.prisma.user.upsert({
      where: { whatsappPhone: phone },
      update: {},
      create: { whatsappPhone: phone }
    });

    const conversation = await getOrCreateWhatsAppConversation(this.prisma, user.id);

    await persistMessage(this.prisma, {
      conversationId: conversation.id,
      role: MessageRole.USER,
      content: input.text,
      rawPayload: input.rawPayload
    });

    try {
      if (input.messageId) {
        this.whatsappService.sendTypingIndicator(input.messageId).catch((error) => {
          logger.warn({ error, messageId: input.messageId }, "Failed to send WhatsApp typing indicator");
        });
      }

      const confirmationIntent = parseConfirmationIntent(input.text);
      if (confirmationIntent) {
        const handled = await this.handleConfirmationIntent({
          intent: confirmationIntent,
          to: input.from,
          user,
          conversation,
          latestUserMessage: input.text
        });
        if (handled) return;
      }

      const genericCalendarOverview = matchGenericCalendarOverviewRequest(input.text);
      if (genericCalendarOverview) {
        const window = calendarOverviewWindow(genericCalendarOverview, user.timezone);
        const result = await this.toolExecutor.executeToolCall(
          "calendar_list_events",
          {
            timeMin: window.timeMin,
            timeMax: window.timeMax,
            maxResults: 50
          },
          {
            user,
            conversation,
            latestUserMessage: input.text
          }
        );

        if (!result.ok) {
          await this.reply(
            conversation.id,
            input.from,
            result.userMessage ?? "I couldn't reach Google Calendar right now."
          );
          return;
        }

        await this.reply(
          conversation.id,
          input.from,
          formatCalendarOverview((result.data as CalendarEventSummary[] | undefined) ?? [], user.timezone, window.label)
        );
        return;
      }

      await this.longTermMemory.maybeExtractMemoryFromConversation(user.id, input.text);

      const history = await this.shortTermMemory.loadConversationHistory(conversation.id);
      const memory = await this.longTermMemory.getRelevantMemoryForPrompt(user.id);
      const pendingAction = await resolvePendingActionFromConversation(
        this.prisma,
        user.id,
        conversation.id
      );
      const prompt = buildSystemPrompt({
        timezone: user.timezone,
        memory,
        pendingContext: buildPendingActionContext(pendingAction),
        readOnlyMode: env.READ_ONLY_MODE,
        nowIso: new Date().toISOString()
      });

      const result = await runResponseLoop({
        client: this.responsesClient,
        model: env.OPENAI_MODEL,
        instructions: prompt,
        tools: getAvailableToolDefinitions(),
        input: history,
        executeTool: (toolName, toolInput) =>
          this.toolExecutor.executeToolCall(toolName, toolInput, {
            user,
            conversation,
            latestUserMessage: input.text
          }),
        maxToolRounds: env.MAX_TOOL_ROUNDS
      });

      await this.reply(conversation.id, input.from, result.assistantMessage);
    } catch (error) {
      logger.error({ error }, "Failed to process inbound WhatsApp message");
      await this.reply(conversation.id, input.from, userMessageForError(error));
    }
  }

  private async handleConfirmationIntent(input: {
    intent: "SEND" | "CONFIRM" | "CANCEL";
    to: string;
    user: User;
    conversation: Conversation;
    latestUserMessage: string;
  }): Promise<boolean> {
    const pending = await resolvePendingActionFromConversation(
      this.prisma,
      input.user.id,
      input.conversation.id
    );

    if (!pending) {
      await this.reply(input.conversation.id, input.to, "No pending action to confirm.");
      return true;
    }

    if (input.intent === "CANCEL") {
      await this.prisma.pendingAction.update({
        where: { id: pending.id },
        data: { status: PendingActionStatus.CANCELLED }
      });
      await this.reply(input.conversation.id, input.to, "Cancelled.");
      return true;
    }

    const expected = expectedConfirmationForPayload(pending.payload);
    if (!matchesPositiveConfirmation(input.intent, expected)) {
      await this.reply(
        input.conversation.id,
        input.to,
        "Reply yes to approve this action, or CANCEL to cancel it."
      );
      return true;
    }

    const result = await this.toolExecutor.executePendingAction(
      pending,
      {
        user: input.user,
        conversation: input.conversation,
        latestUserMessage: input.latestUserMessage
      },
      input.intent
    );

    await this.reply(input.conversation.id, input.to, result.userMessage ?? "Done.");
    return true;
  }

  private async reply(conversationId: string, to: string, message: string): Promise<void> {
    await persistMessage(this.prisma, {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: message
    });
    await this.whatsappService.sendTextMessage(to, message);
  }
}

function normalizePhone(phone: string): string {
  return phone.startsWith("+") ? phone : `+${phone}`;
}
