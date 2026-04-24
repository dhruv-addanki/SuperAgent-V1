import {
  MessageRole,
  MessageSenderType,
  PendingActionStatus,
  type Conversation,
  type PrismaClient,
  type User
} from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { ResponsesClient } from "../../lib/openaiClient";
import { userMessageForError } from "../../lib/errors";
import { AudioTranscriptionService } from "../audio/audioTranscriptionService";
import { WhatsAppService } from "../whatsapp/whatsappService";
import { WhatsAppMediaService } from "../whatsapp/whatsappMediaService";
import type { WhatsAppInboundMessagePayload } from "../whatsapp/whatsappTypes";
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
  buildConversationContext,
  formatConversationContextForPrompt
} from "./conversationContext";
import { isCompoundIntentRequest } from "./compoundIntent";
import {
  asanaTaskDueDate,
  formatAsanaTaskOverview,
  formatAsanaTodayAndLatestOpenReply,
  formatLatestAsanaTaskReply,
  formatScopedAsanaTaskList,
  matchAmbiguousAsanaBulkCompleteRequest,
  matchAsanaDueTodayAndLatestOpenRequest,
  matchAsanaLatestTaskShortcut,
  matchAsanaListShortcut,
  matchGenericAsanaMyTasksRequest
} from "./asanaReadShortcut";
import {
  calendarOverviewWindow,
  formatCalendarOverview,
  matchCalendarAllCalendarsFollowUpRequest,
  matchGenericCalendarOverviewRequest
} from "./calendarReadShortcut";
import type { AsanaTaskSummary } from "../asana/asanaTypes";
import type { CalendarEventSummary } from "../google/googleTypes";

export interface InboundWhatsAppTextInput {
  from: string;
  text: string;
  messageId?: string;
  rawPayload?: unknown;
}

interface PreparedInboundText {
  from: string;
  text: string;
  messageId?: string;
  rawPayload?: unknown;
}

interface AgentOrchestratorOptions {
  whatsappMediaService?: Pick<WhatsAppMediaService, "downloadAudio">;
  audioTranscriptionService?: Pick<AudioTranscriptionService, "transcribe">;
}

export class AgentOrchestrator {
  private readonly toolExecutor: ToolExecutor;
  private readonly shortTermMemory: ShortTermMemory;
  private readonly longTermMemory: LongTermMemory;
  private readonly whatsappMediaService: Pick<WhatsAppMediaService, "downloadAudio">;
  private readonly audioTranscriptionService: Pick<AudioTranscriptionService, "transcribe">;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly responsesClient: ResponsesClient,
    private readonly whatsappService: WhatsAppService,
    options: AgentOrchestratorOptions = {}
  ) {
    const googleTokenService = new GoogleTokenService(prisma);
    const asanaTokenService = new AsanaTokenService(prisma);
    this.toolExecutor = new ToolExecutor(prisma, googleTokenService, asanaTokenService);
    this.shortTermMemory = new ShortTermMemory(prisma);
    this.longTermMemory = new LongTermMemory(prisma);
    this.whatsappMediaService = options.whatsappMediaService ?? new WhatsAppMediaService();
    this.audioTranscriptionService =
      options.audioTranscriptionService ?? new AudioTranscriptionService();
  }

  async processInboundWhatsAppText(input: InboundWhatsAppTextInput): Promise<void> {
    await this.processInboundWhatsAppMessage({
      kind: "text",
      from: input.from,
      text: input.text,
      messageId: input.messageId ?? "",
      raw: input.rawPayload ?? null
    });
  }

  async processInboundWhatsAppMessage(input: WhatsAppInboundMessagePayload): Promise<void> {
    const phone = normalizePhone(input.from);
    const user = await this.prisma.user.upsert({
      where: { whatsappPhone: phone },
      update: {},
      create: { whatsappPhone: phone }
    });

    const conversation = await getOrCreateWhatsAppConversation(this.prisma, user.id);

    try {
      if (input.messageId) {
        this.whatsappService.sendTypingIndicator(input.messageId).catch((error) => {
          logger.warn({ error, messageId: input.messageId }, "Failed to send WhatsApp typing indicator");
        });
      }

      const preparedInput = await this.prepareInboundText(input);

      await persistMessage(this.prisma, {
        conversationId: conversation.id,
        role: MessageRole.USER,
        senderType: MessageSenderType.USER,
        senderPhone: phone,
        content: preparedInput.text,
        rawPayload: preparedInput.rawPayload
      });

      await this.longTermMemory.maybeExtractMemoryFromConversation(user.id, preparedInput.text);

      const history = await this.shortTermMemory.loadConversationHistory(conversation.id);
      const memoryEntries = await this.longTermMemory.getRecentEntriesForContext(user.id);
      const isCompoundIntent = isCompoundIntentRequest(preparedInput.text);

      const confirmationIntent = parseConfirmationIntent(preparedInput.text);
      if (confirmationIntent) {
        const handled = await this.handleConfirmationIntent({
          intent: confirmationIntent,
          to: preparedInput.from,
          user,
          conversation,
          latestUserMessage: preparedInput.text
        });
        if (handled) return;
      }

      const ambiguousBulkComplete = matchAmbiguousAsanaBulkCompleteRequest(
        preparedInput.text,
        memoryEntries
      );
      if (ambiguousBulkComplete) {
        const scopeLabel = ambiguousBulkComplete.projectName
          ? `${ambiguousBulkComplete.taskCount} listed tasks in ${ambiguousBulkComplete.projectName}`
          : `${ambiguousBulkComplete.taskCount} listed tasks`;
        await this.reply(
          conversation.id,
          preparedInput.from,
          `Do you mean ${scopeLabel}, or every incomplete Asana task I can see?`
        );
        return;
      }

      const genericCalendarOverview =
        !isCompoundIntent
          ? matchGenericCalendarOverviewRequest(preparedInput.text) ??
            matchCalendarAllCalendarsFollowUpRequest(preparedInput.text, history)
          : null;
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
            latestUserMessage: preparedInput.text
          }
        );

        if (!result.ok) {
          await this.reply(
            conversation.id,
            preparedInput.from,
            result.userMessage ?? "I couldn't load your calendar right now. Try again in a moment."
          );
          return;
        }

        await this.reply(
          conversation.id,
          preparedInput.from,
          formatCalendarOverview((result.data as CalendarEventSummary[] | undefined) ?? [], user.timezone, window.label)
        );
        return;
      }

      const asanaTodayAndLatestOpen = matchAsanaDueTodayAndLatestOpenRequest(
        preparedInput.text,
        history,
        memoryEntries,
        user.timezone
      );
      if (asanaTodayAndLatestOpen) {
        const [todayResult, latestOpenResult] = await Promise.all([
          this.toolExecutor.executeToolCall(
            "asana_list_my_tasks",
            {
              dueOn: asanaTodayAndLatestOpen.dueOn,
              completed: false,
              limit: 20,
              sortBy: "due",
              sortDirection: "asc"
            },
            {
              user,
              conversation,
              latestUserMessage: preparedInput.text
            }
          ),
          this.toolExecutor.executeToolCall(
            "asana_list_my_tasks",
            {
              completed: false,
              limit: 1,
              sortBy: "modifiedAt",
              sortDirection: "desc"
            },
            {
              user,
              conversation,
              latestUserMessage: preparedInput.text
            }
          )
        ]);

        if (!todayResult.ok) {
          await this.reply(
            conversation.id,
            preparedInput.from,
            todayResult.userMessage ?? "I couldn't load your Asana tasks right now. Try again in a moment."
          );
          return;
        }

        if (!latestOpenResult.ok) {
          await this.reply(
            conversation.id,
            preparedInput.from,
            latestOpenResult.userMessage ?? "I couldn't load your latest Asana task right now. Try again in a moment."
          );
          return;
        }

        await this.reply(
          conversation.id,
          preparedInput.from,
          formatAsanaTodayAndLatestOpenReply(
            (todayResult.data as AsanaTaskSummary[] | undefined) ?? [],
            ((latestOpenResult.data as AsanaTaskSummary[] | undefined) ?? [])[0] ?? null,
            user.timezone,
            asanaTodayAndLatestOpen.label
          )
        );
        return;
      }

      const asanaLatestShortcut = matchAsanaLatestTaskShortcut(
        preparedInput.text,
        history,
        memoryEntries
      );
      if (!isCompoundIntent && asanaLatestShortcut) {
        const toolName =
          asanaLatestShortcut.scope === "project" ? "asana_list_project_tasks" : "asana_list_my_tasks";
        const result = await this.toolExecutor.executeToolCall(
          toolName,
          {
            ...(asanaLatestShortcut.project
              ? { projectGid: asanaLatestShortcut.project.projectGid }
              : {}),
            completed: asanaLatestShortcut.completed,
            limit: asanaLatestShortcut.limit,
            sortBy: asanaLatestShortcut.sortBy,
            sortDirection: asanaLatestShortcut.sortDirection
          },
          {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }
        );

        if (!result.ok) {
          await this.reply(
            conversation.id,
            preparedInput.from,
            result.userMessage ?? "I couldn't load that Asana task right now. Try again in a moment."
          );
          return;
        }

        await this.reply(
          conversation.id,
          preparedInput.from,
          formatLatestAsanaTaskReply(
            ((result.data as AsanaTaskSummary[] | undefined) ?? [])[0] ?? null,
            {
              label: asanaLatestShortcut.label,
              timezone: user.timezone,
              scopeName: asanaLatestShortcut.project?.name,
              completed: asanaLatestShortcut.completed
            }
          )
        );
        return;
      }

      const asanaListShortcut = matchAsanaListShortcut(
        preparedInput.text,
        history,
        memoryEntries,
        user.timezone
      );
      if (!isCompoundIntent && asanaListShortcut) {
        const toolName =
          asanaListShortcut.scope === "project" ? "asana_list_project_tasks" : "asana_list_my_tasks";
        const result = await this.toolExecutor.executeToolCall(
          toolName,
          {
            ...(asanaListShortcut.project
              ? { projectGid: asanaListShortcut.project.projectGid }
              : {}),
            completed: asanaListShortcut.completed,
            dueOn: asanaListShortcut.dueOn,
            dueBefore: asanaListShortcut.dueBefore,
            limit: asanaListShortcut.limit,
            sortBy: asanaListShortcut.sortBy,
            sortDirection: asanaListShortcut.sortDirection
          },
          {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }
        );

        if (!result.ok) {
          await this.reply(
            conversation.id,
            preparedInput.from,
            result.userMessage ?? "I couldn't load those Asana tasks right now. Try again in a moment."
          );
          return;
        }

        await this.reply(
          conversation.id,
          preparedInput.from,
          formatScopedAsanaTaskList(
            (result.data as AsanaTaskSummary[] | undefined) ?? [],
            {
              label: asanaListShortcut.label,
              emptyLabel: `I don't see open Asana tasks ${asanaListShortcut.label}${asanaListShortcut.project ? ` in ${asanaListShortcut.project.name}` : ""}.`,
              scopeName: asanaListShortcut.project?.name,
              emphasizeImportance: asanaListShortcut.emphasizeImportance
            }
          )
        );
        return;
      }

      const genericAsanaTaskOverview = matchGenericAsanaMyTasksRequest(preparedInput.text);
      if (!isCompoundIntent && genericAsanaTaskOverview) {
        const result = await this.toolExecutor.executeToolCall(
          "asana_list_my_tasks",
          {
            dueOn: asanaTaskDueDate(genericAsanaTaskOverview, user.timezone),
            completed: false,
            limit: 20
          },
          {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }
        );

        if (!result.ok) {
          await this.reply(
            conversation.id,
            preparedInput.from,
            result.userMessage ?? "I couldn't load your Asana tasks right now. Try again in a moment."
          );
          return;
        }

        await this.reply(
          conversation.id,
          preparedInput.from,
          formatAsanaTaskOverview(
            (result.data as AsanaTaskSummary[] | undefined) ?? [],
            genericAsanaTaskOverview
          )
        );
        return;
      }

      const pendingAction = await resolvePendingActionFromConversation(
        this.prisma,
        user.id,
        conversation.id
      );
      const conversationContext = buildConversationContext({
        latestUserMessage: preparedInput.text,
        memoryEntries,
        pendingAction,
        pendingActionSummary: buildPendingActionContext(pendingAction)
      });
      const prompt = buildSystemPrompt({
        timezone: user.timezone,
        conversationContext: formatConversationContextForPrompt(conversationContext),
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
            latestUserMessage: preparedInput.text
          }),
        maxToolRounds: env.MAX_TOOL_ROUNDS
      });

      await this.reply(conversation.id, preparedInput.from, result.assistantMessage);
    } catch (error) {
      logger.error({ error }, "Failed to process inbound WhatsApp message");
      await this.reply(conversation.id, input.from, userMessageForError(error));
    }
  }

  private async prepareInboundText(
    input: WhatsAppInboundMessagePayload
  ): Promise<PreparedInboundText> {
    if (input.kind === "text") {
      return {
        from: input.from,
        text: input.text,
        messageId: input.messageId,
        rawPayload: input.raw
      };
    }

    const media = await this.whatsappMediaService.downloadAudio({
      mediaId: input.mediaId,
      mimeType: input.mimeType,
      sha256: input.sha256
    });
    const transcription = await this.audioTranscriptionService.transcribe({
      buffer: media.buffer,
      filename: media.filename,
      mimeType: media.mimeType
    });

    return {
      from: input.from,
      text: transcription.text,
      messageId: input.messageId,
      rawPayload: {
        kind: "audio",
        mediaId: input.mediaId,
        mimeType: input.mimeType,
        downloadedMimeType: media.mimeType,
        sha256: media.sha256,
        isVoice: input.isVoice,
        transcription: {
          model: transcription.model
        },
        raw: input.raw
      }
    };
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
      await this.reply(input.conversation.id, input.to, "There isn't anything pending to confirm right now.");
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
        "Reply yes to approve it, or CANCEL to cancel it."
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
      senderType: MessageSenderType.AGENT,
      content: message
    });
    await this.whatsappService.sendTextMessage(to, message);
  }
}

function normalizePhone(phone: string): string {
  return phone.startsWith("+") ? phone : `+${phone}`;
}
