import {
  MessageRole,
  PendingActionStatus,
  type Conversation,
  type PrismaClient,
  type User
} from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { ResponseInputItem, ResponsesClient } from "../../lib/openaiClient";
import { userMessageForError } from "../../lib/errors";
import { normalizeAssistantMessageForUser } from "../../lib/messageText";
import { AudioTranscriptionService } from "../audio/audioTranscriptionService";
import { WhatsAppService } from "../whatsapp/whatsappService";
import { WhatsAppMediaService } from "../whatsapp/whatsappMediaService";
import type { WhatsAppInboundMessagePayload } from "../whatsapp/whatsappTypes";
import { AsanaTokenService } from "../asana/tokenService";
import { GoogleTokenService } from "../google/tokenService";
import { NotionTokenService } from "../notion/tokenService";
import { LongTermMemory, type AssistantResponsePreferences } from "../memory/longTermMemory";
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
import { ToolExecutor, type ToolExecutionResult } from "./toolExecutor";
import { getAvailableToolDefinitions } from "./toolRegistry";
import { extractOutputText, runResponseLoop } from "./responseLoop";
import {
  buildConversationContext,
  formatConversationContextForPrompt,
  type PromptMemoryEntry
} from "./conversationContext";
import {
  formatMissingIntegrationForWhatsApp,
  formatIntegrationLinkForWhatsApp,
  formatSetupHintForWhatsApp,
  formatSetupStatusForWhatsApp,
  integrationLinkRequestForMessage,
  isGreetingOnly,
  isSetupStatusRequest,
  missingIntegrationsForRequest,
  setupStatusProfileLines,
  SetupStatusService,
  type SetupStatus
} from "./setupStatusService";
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
  matchGenericAsanaOpenTasksRequest,
  matchGenericAsanaMyTasksRequest
} from "./asanaReadShortcut";
import {
  calendarOverviewWindow,
  formatCalendarOverview,
  matchCalendarAllCalendarsFollowUpRequest,
  matchGenericCalendarOverviewRequest
} from "./calendarReadShortcut";
import type { AsanaTaskSummary } from "../asana/asanaTypes";
import type { CalendarEventSummary, GmailThreadSummary } from "../google/googleTypes";

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
  modelInputItem?: ResponseInputItem;
  imageContext?: PreparedImageContext;
}

interface PreparedImageContext {
  mediaId: string;
  caption?: string;
  mimeType?: string;
  downloadedMimeType: string;
  sha256?: string;
}

interface AgentOrchestratorOptions {
  whatsappMediaService?: Pick<WhatsAppMediaService, "downloadAudio" | "downloadImage">;
  audioTranscriptionService?: Pick<AudioTranscriptionService, "transcribe">;
}

export class AgentOrchestrator {
  private readonly toolExecutor: ToolExecutor;
  private readonly shortTermMemory: ShortTermMemory;
  private readonly longTermMemory: LongTermMemory;
  private readonly setupStatusService: SetupStatusService;
  private readonly whatsappMediaService: Pick<
    WhatsAppMediaService,
    "downloadAudio" | "downloadImage"
  >;
  private readonly audioTranscriptionService: Pick<AudioTranscriptionService, "transcribe">;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly responsesClient: ResponsesClient,
    private readonly whatsappService: WhatsAppService,
    options: AgentOrchestratorOptions = {}
  ) {
    const googleTokenService = new GoogleTokenService(prisma);
    const asanaTokenService = new AsanaTokenService(prisma);
    const notionTokenService = new NotionTokenService(prisma);
    this.toolExecutor = new ToolExecutor(
      prisma,
      googleTokenService,
      asanaTokenService,
      notionTokenService
    );
    this.shortTermMemory = new ShortTermMemory(prisma);
    this.longTermMemory = new LongTermMemory(prisma);
    this.setupStatusService = new SetupStatusService(prisma);
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
    let user = await this.prisma.user.upsert({
      where: { whatsappPhone: phone },
      update: {},
      create: { whatsappPhone: phone }
    });

    const conversation = await getOrCreateWhatsAppConversation(this.prisma, user.id);

    try {
      if (input.messageId) {
        this.whatsappService.sendTypingIndicator(input.messageId).catch((error) => {
          logger.warn(
            { error, messageId: input.messageId },
            "Failed to send WhatsApp typing indicator"
          );
        });
      }

      const preparedInput = await this.prepareInboundText(input);

      await persistMessage(this.prisma, {
        conversationId: conversation.id,
        role: MessageRole.USER,
        senderPhone: phone,
        content: preparedInput.text,
        rawPayload: preparedInput.rawPayload
      });

      const memoryExtraction = await this.longTermMemory.maybeExtractMemoryFromConversation(
        user,
        preparedInput.text
      );
      if (memoryExtraction.timezone) {
        user = { ...user, timezone: memoryExtraction.timezone };
      }
      await this.maybeRememberImageContext(user.id, preparedInput);

      const responsePreferences = memoryExtraction.responsePreferences;
      if (
        responsePreferences &&
        isResponsePreferenceOnlyMessage(preparedInput.text, responsePreferences)
      ) {
        await this.reply(
          conversation.id,
          preparedInput.from,
          formatResponsePreferenceAcknowledgement(responsePreferences)
        );
        return;
      }

      const history = await this.shortTermMemory.loadConversationHistory(conversation.id);
      const memoryEntries = await this.longTermMemory.getRecentEntriesForContext(user.id);
      const setupStatus = await this.setupStatusService.getStatus(user);
      const setupRequest = isSetupStatusRequest(preparedInput.text);
      const integrationLinkRequest = integrationLinkRequestForMessage(
        preparedInput.text,
        setupStatus
      );
      const firstInteraction = isFirstInteraction(history);
      const isCompoundIntent = isCompoundIntentRequest(preparedInput.text);
      const shouldUseTextShortcuts = !preparedInput.modelInputItem;
      const appendSetupHint =
        firstInteraction &&
        !setupRequest &&
        !isGreetingOnly(preparedInput.text) &&
        !setupStatus.hasAnyConnected;
      const replyToUser = async (
        message: string,
        options: { allowSetupHint?: boolean } = {}
      ): Promise<void> => {
        const allowSetupHint = options.allowSetupHint ?? true;
        await this.reply(
          conversation.id,
          preparedInput.from,
          allowSetupHint && appendSetupHint
            ? appendSetupHintToMessage(message, setupStatus)
            : message
        );
      };

      if (integrationLinkRequest) {
        await replyToUser(formatIntegrationLinkForWhatsApp(integrationLinkRequest), {
          allowSetupHint: false
        });
        return;
      }

      if (
        setupRequest ||
        (firstInteraction && isGreetingOnly(preparedInput.text) && !setupStatus.hasAnyConnected)
      ) {
        await replyToUser(formatSetupStatusForWhatsApp(setupStatus), { allowSetupHint: false });
        return;
      }

      const missingRequiredIntegrations = missingIntegrationsForRequest(
        preparedInput.text,
        setupStatus
      );
      if (missingRequiredIntegrations.length > 1) {
        await replyToUser(formatSetupStatusForWhatsApp(setupStatus), { allowSetupHint: false });
        return;
      }
      if (missingRequiredIntegrations.length === 1) {
        await replyToUser(formatMissingIntegrationForWhatsApp(missingRequiredIntegrations[0]!), {
          allowSetupHint: false
        });
        return;
      }

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

      const oneTimeAutomationDigest = matchOneTimeAutomationDigestRequest(
        preparedInput.text,
        history
      );
      if (shouldUseTextShortcuts && oneTimeAutomationDigest) {
        await replyToUser(
          await this.runOneTimeMorningDigest({
            user,
            conversation,
            latestUserMessage: preparedInput.text
          })
        );
        return;
      }

      const missingAutomationRetry = matchMissingAutomationDigestRetry(preparedInput.text, history);
      if (shouldUseTextShortcuts && missingAutomationRetry) {
        const calendarWindow = calendarOverviewWindow("today", user.timezone);
        const [gmailResult, calendarResult, asanaResult] = await Promise.all([
          missingAutomationRetry.gmail
            ? this.toolExecutor.executeToolCall(
                "gmail_search_threads",
                {
                  query: "in:inbox newer_than:1d",
                  maxResults: 10
                },
                {
                  user,
                  conversation,
                  latestUserMessage: preparedInput.text
                }
              )
            : Promise.resolve(null),
          missingAutomationRetry.calendar
            ? this.toolExecutor.executeToolCall(
                "calendar_list_events",
                {
                  timeMin: calendarWindow.timeMin,
                  timeMax: calendarWindow.timeMax,
                  maxResults: 50
                },
                {
                  user,
                  conversation,
                  latestUserMessage: preparedInput.text
                }
              )
            : Promise.resolve(null),
          missingAutomationRetry.asana
            ? this.toolExecutor.executeToolCall(
                "asana_list_my_tasks",
                {
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
              )
            : Promise.resolve(null)
        ]);

        await replyToUser(
          formatMissingAutomationRetryReply({
            gmailResult,
            calendarResult,
            asanaResult,
            timezone: user.timezone
          })
        );
        return;
      }

      const ambiguousBulkComplete = matchAmbiguousAsanaBulkCompleteRequest(
        preparedInput.text,
        memoryEntries
      );
      if (shouldUseTextShortcuts && ambiguousBulkComplete) {
        const scopeLabel = ambiguousBulkComplete.projectName
          ? `${ambiguousBulkComplete.taskCount} listed tasks in ${ambiguousBulkComplete.projectName}`
          : `${ambiguousBulkComplete.taskCount} listed tasks`;
        await replyToUser(`Do you mean ${scopeLabel}, or every incomplete Asana task I can see?`);
        return;
      }

      const recentGoogleDocToDelete = matchRecentGoogleDocDeleteRequest(
        preparedInput.text,
        memoryEntries
      );
      if (shouldUseTextShortcuts && recentGoogleDocToDelete) {
        const result = await this.toolExecutor.executeToolCall(
          "drive_delete_file",
          { fileId: recentGoogleDocToDelete.documentId },
          {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }
        );
        await replyToUser(
          result.userMessage ??
            (result.ok
              ? `Moved to trash: ${recentGoogleDocToDelete.title ?? "Google Doc"}`
              : "I couldn't delete that Google Doc right now.")
        );
        return;
      }

      const genericCalendarOverview =
        shouldUseTextShortcuts && !isCompoundIntent
          ? (matchGenericCalendarOverviewRequest(preparedInput.text) ??
            matchCalendarAllCalendarsFollowUpRequest(preparedInput.text, history))
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
          await replyToUser(
            result.userMessage ?? "I couldn't load your calendar right now. Try again in a moment."
          );
          return;
        }

        await replyToUser(
          formatCalendarOverview(
            (result.data as CalendarEventSummary[] | undefined) ?? [],
            user.timezone,
            window.label
          )
        );
        return;
      }

      const asanaTodayAndLatestOpen = matchAsanaDueTodayAndLatestOpenRequest(
        preparedInput.text,
        history,
        memoryEntries,
        user.timezone
      );
      if (shouldUseTextShortcuts && asanaTodayAndLatestOpen) {
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
          await replyToUser(
            todayResult.userMessage ??
              "I couldn't load your Asana tasks right now. Try again in a moment."
          );
          return;
        }

        if (!latestOpenResult.ok) {
          await replyToUser(
            latestOpenResult.userMessage ??
              "I couldn't load your latest Asana task right now. Try again in a moment."
          );
          return;
        }

        await replyToUser(
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
      if (shouldUseTextShortcuts && !isCompoundIntent && asanaLatestShortcut) {
        const toolName =
          asanaLatestShortcut.scope === "project"
            ? "asana_list_project_tasks"
            : "asana_list_my_tasks";
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
          await replyToUser(
            result.userMessage ??
              "I couldn't load that Asana task right now. Try again in a moment."
          );
          return;
        }

        await replyToUser(
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
      if (shouldUseTextShortcuts && !isCompoundIntent && asanaListShortcut) {
        const toolName =
          asanaListShortcut.scope === "project"
            ? "asana_list_project_tasks"
            : "asana_list_my_tasks";
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
          await replyToUser(
            result.userMessage ??
              "I couldn't load those Asana tasks right now. Try again in a moment."
          );
          return;
        }

        await replyToUser(
          formatScopedAsanaTaskList((result.data as AsanaTaskSummary[] | undefined) ?? [], {
            label: asanaListShortcut.label,
            emptyLabel: `I don't see open Asana tasks ${asanaListShortcut.label}${asanaListShortcut.project ? ` in ${asanaListShortcut.project.name}` : ""}.`,
            scopeName: asanaListShortcut.project?.name,
            emphasizeImportance: asanaListShortcut.emphasizeImportance
          })
        );
        return;
      }

      const genericAsanaOpenTasks = matchGenericAsanaOpenTasksRequest(preparedInput.text);
      if (shouldUseTextShortcuts && !isCompoundIntent && genericAsanaOpenTasks) {
        const result = await this.toolExecutor.executeToolCall(
          "asana_list_my_tasks",
          {
            completed: false,
            limit: 50,
            sortBy: "due",
            sortDirection: "asc"
          },
          {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }
        );

        if (!result.ok) {
          await replyToUser(
            result.userMessage ??
              "I couldn't load your Asana tasks right now. Try again in a moment."
          );
          return;
        }

        await replyToUser(
          formatScopedAsanaTaskList((result.data as AsanaTaskSummary[] | undefined) ?? [], {
            label: "from My Tasks",
            emptyLabel: "I don't see any open Asana tasks in My Tasks.",
            emphasizeImportance: true
          })
        );
        return;
      }

      const genericAsanaTaskOverview = matchGenericAsanaMyTasksRequest(preparedInput.text);
      if (shouldUseTextShortcuts && !isCompoundIntent && genericAsanaTaskOverview) {
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
          await replyToUser(
            result.userMessage ??
              "I couldn't load your Asana tasks right now. Try again in a moment."
          );
          return;
        }

        await replyToUser(
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
        pendingActionSummary: buildPendingActionContext(pendingAction),
        userProfile: setupStatusProfileLines(setupStatus, user.timezone)
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
        input: inputWithPreparedCurrentTurn(history, preparedInput),
        executeTool: (toolName, toolInput) =>
          this.toolExecutor.executeToolCall(toolName, toolInput, {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }),
        maxToolRounds: env.MAX_TOOL_ROUNDS
      });

      await replyToUser(result.assistantMessage);
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

    if (input.kind === "image") {
      const media = await this.whatsappMediaService.downloadImage({
        mediaId: input.mediaId,
        mimeType: input.mimeType,
        sha256: input.sha256
      });
      const text = input.caption?.trim() || "User sent an image.";
      const imageDataUrl = `data:${media.mimeType};base64,${media.buffer.toString("base64")}`;

      return {
        from: input.from,
        text,
        messageId: input.messageId,
        rawPayload: {
          kind: "image",
          mediaId: input.mediaId,
          mimeType: input.mimeType,
          downloadedMimeType: media.mimeType,
          sha256: media.sha256,
          caption: input.caption,
          raw: input.raw
        },
        modelInputItem: buildImageInputItem(text, imageDataUrl),
        imageContext: {
          mediaId: input.mediaId,
          caption: input.caption,
          mimeType: input.mimeType,
          downloadedMimeType: media.mimeType,
          sha256: media.sha256
        }
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

  private async maybeRememberImageContext(
    userId: string,
    preparedInput: PreparedInboundText
  ): Promise<void> {
    if (!preparedInput.imageContext || !preparedInput.modelInputItem) return;

    try {
      const response = await this.responsesClient.createResponse({
        model: env.OPENAI_MODEL,
        instructions: [
          "Summarize this WhatsApp image for later assistant follow-ups.",
          "Return 3 concise fields in plain text: Visible text, Visual context, Likely user intent.",
          "Do not identify people. If details are unclear, say unclear."
        ].join("\n"),
        tools: [],
        input: [preparedInput.modelInputItem]
      });
      const summary = extractOutputText(response);
      if (!summary) return;
      const value = imageContextMemoryValue(preparedInput.imageContext, summary);

      await this.prisma.memoryEntry.upsert({
        where: { userId_key: { userId, key: "recent_image_context" } },
        update: {
          value,
          confidence: 0.7
        },
        create: {
          userId,
          key: "recent_image_context",
          value,
          confidence: 0.7
        }
      });
    } catch (error) {
      logger.warn({ error }, "Failed to store WhatsApp image context");
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
      if (input.intent === "CANCEL") {
        await this.reply(input.conversation.id, input.to, "Nothing to cancel.");
        return true;
      }
      return false;
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

  private async runOneTimeMorningDigest(input: {
    user: User;
    conversation: Conversation;
    latestUserMessage: string;
  }): Promise<string> {
    const calendarWindow = calendarOverviewWindow("today", input.user.timezone);
    const [gmailResult, calendarResult, asanaResult] = await Promise.all([
      this.toolExecutor.executeToolCall(
        "gmail_search_threads",
        {
          query: "in:inbox newer_than:1d",
          maxResults: 10
        },
        input,
        { force: true }
      ),
      this.toolExecutor.executeToolCall(
        "calendar_list_events",
        {
          timeMin: calendarWindow.timeMin,
          timeMax: calendarWindow.timeMax,
          maxResults: 50
        },
        input,
        { force: true }
      ),
      this.toolExecutor.executeToolCall(
        "asana_list_my_tasks",
        {
          completed: false,
          limit: 50,
          sortBy: "due",
          sortDirection: "asc"
        },
        input,
        { force: true }
      )
    ]);

    return formatOneTimeMorningDigest({
      gmailResult,
      calendarResult,
      asanaResult,
      timezone: input.user.timezone
    });
  }

  private async reply(conversationId: string, to: string, message: string): Promise<void> {
    const safeMessage = normalizeAssistantMessageForUser(message);
    await persistMessage(this.prisma, {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: safeMessage
    });
    await this.whatsappService.sendTextMessage(to, safeMessage);
  }
}

function normalizePhone(phone: string): string {
  return phone.startsWith("+") ? phone : `+${phone}`;
}

function isFirstInteraction(history: Array<{ role?: unknown }>): boolean {
  const userMessageCount = history.filter((item) => item.role === "user").length;
  return userMessageCount > 0 && userMessageCount <= 1;
}

function appendSetupHintToMessage(message: string, setupStatus: SetupStatus): string {
  const hint = formatSetupHintForWhatsApp(setupStatus);
  return message.includes(hint) ? message : `${message}\n\n${hint}`;
}

function matchOneTimeAutomationDigestRequest(text: string, history: ResponseInputItem[]): boolean {
  const normalized = text.toLowerCase().replace(/[’]/g, "'").trim();

  const directRun =
    /\b(run|do|trigger|start)\b.*\b(?:8\s*am|morning|daily)?\s*(?:automation|digest)\b.*\b(now|manual|manually|one[ -]?time|exception)\b/.test(
      normalized
    ) || /\b(run|do)\b.*\b(one[ -]?time|manual|manually)\b.*\b(digest|checks?)\b/.test(normalized);
  if (directRun) return true;

  const previousAssistant = lastAssistantMessage(history);
  if (!previousAssistant) return false;
  const previous = previousAssistant.toLowerCase().replace(/[’]/g, "'");
  const offeredManualDigest =
    /\bsame checks manually\b/.test(previous) || /\bone[ -]?time digest now\b/.test(previous);
  if (!offeredManualDigest) return false;

  return (
    /^(yes|yep|yeah|sure|ok|okay|do it|go ahead)\b/.test(normalized) ||
    /\bdo it manually\b/.test(normalized) ||
    /\brun it\b/.test(normalized)
  );
}

function matchMissingAutomationDigestRetry(
  text: string,
  history: ResponseInputItem[]
): { gmail: boolean; calendar: boolean; asana: boolean } | null {
  const normalized = text.toLowerCase().replace(/[’]/g, "'").trim();
  const asksRetry =
    /^(yes|yep|yeah|sure|ok|okay)\b.*\b(retry|try again|missing|gmail|email|mail|calendar|asana|parts?)\b/.test(
      normalized
    ) ||
    /\b(retry|try again)\b.*\b(missing|gmail|email|mail|calendar|asana|parts?)\b/.test(normalized);
  if (!asksRetry) return null;

  const previousAssistant = lastAssistantMessage(history);
  if (!previousAssistant) return null;
  const previous = previousAssistant.toLowerCase().replace(/[’]/g, "'");
  if (!/morning digest|automation|digest/.test(previous)) return null;

  const gmail = previousDigestSourceFailed(previous, [
    /\bgmail\b/,
    /\bemail\b/,
    /\bemails\b/,
    /\binbox\b/
  ]);
  const calendar = previousDigestSourceFailed(previous, [/\bcalendar\b/, /\bschedule\b/]);
  const asana = previousDigestSourceFailed(previous, [/\basana\b/, /\bmy tasks\b/]);

  if (!gmail && !calendar && !asana) return null;
  return { gmail, calendar, asana };
}

function formatMissingAutomationRetryReply(input: {
  gmailResult: ToolExecutionResult | null;
  calendarResult: ToolExecutionResult | null;
  asanaResult: ToolExecutionResult | null;
  timezone: string;
}): string {
  const sections = ["Retried the missing parts."];

  if (input.gmailResult) {
    if (input.gmailResult.ok) {
      sections.push(["Gmail:", formatGmailRetrySnapshot(input.gmailResult.data)].join("\n"));
    } else {
      sections.push(
        `Gmail: ${
          input.gmailResult.userMessage ??
          "I still couldn't reach Gmail, so recent inbox threads are unavailable."
        }`
      );
    }
  }

  if (input.calendarResult) {
    if (input.calendarResult.ok) {
      sections.push(
        formatCalendarOverview(
          (input.calendarResult.data as CalendarEventSummary[] | undefined) ?? [],
          input.timezone,
          "today"
        )
      );
    } else {
      sections.push(
        `Calendar: ${
          input.calendarResult.userMessage ??
          "I still couldn't reach Google Calendar, so today's schedule is unavailable."
        }`
      );
    }
  }

  if (input.asanaResult) {
    if (input.asanaResult.ok) {
      sections.push(
        [
          "Asana:",
          formatScopedAsanaTaskList(
            (input.asanaResult.data as AsanaTaskSummary[] | undefined) ?? [],
            {
              label: "from My Tasks",
              emptyLabel: "I don't see any open Asana tasks in My Tasks.",
              emphasizeImportance: true
            }
          )
        ].join("\n")
      );
    } else {
      sections.push(
        `Asana: ${
          input.asanaResult.userMessage ?? "I still couldn't load your Asana My Tasks in this run."
        }`
      );
    }
  }

  return sections.join("\n\n");
}

function formatOneTimeMorningDigest(input: {
  gmailResult: ToolExecutionResult;
  calendarResult: ToolExecutionResult;
  asanaResult: ToolExecutionResult;
  timezone: string;
}): string {
  const sections = [
    "Morning email, calendar, and Asana digest",
    `At a glance: ${formatOneTimeDigestGlance(input)}`
  ];

  if (input.gmailResult.ok) {
    sections.push(["Gmail:", formatGmailRetrySnapshot(input.gmailResult.data)].join("\n"));
  }

  if (input.calendarResult.ok) {
    sections.push(
      [
        "Schedule:",
        formatCalendarOverview(
          (input.calendarResult.data as CalendarEventSummary[] | undefined) ?? [],
          input.timezone,
          "today"
        )
      ].join("\n")
    );
  }

  if (input.asanaResult.ok) {
    sections.push(
      [
        "Asana:",
        formatScopedAsanaTaskList(
          (input.asanaResult.data as AsanaTaskSummary[] | undefined) ?? [],
          {
            label: "from My Tasks",
            emptyLabel: "I don't see any open Asana tasks in My Tasks.",
            emphasizeImportance: true
          }
        )
      ].join("\n")
    );
  }

  const watchouts = formatOneTimeDigestWatchouts(input);
  if (watchouts.length) {
    sections.push(["Watchouts:", ...watchouts.map((watchout) => `• ${watchout}`)].join("\n"));
  }

  return sections.join("\n\n");
}

function formatOneTimeDigestGlance(input: {
  gmailResult: ToolExecutionResult;
  calendarResult: ToolExecutionResult;
  asanaResult: ToolExecutionResult;
}): string {
  const parts = [
    input.gmailResult.ok
      ? `Gmail found ${countItems(input.gmailResult.data)} recent ${plural(countItems(input.gmailResult.data), "thread")}`
      : "Gmail is unavailable",
    input.calendarResult.ok
      ? `${countItems(input.calendarResult.data)} calendar ${plural(countItems(input.calendarResult.data), "event")} today`
      : "calendar is unavailable",
    input.asanaResult.ok
      ? `${countItems(input.asanaResult.data)} open Asana ${plural(countItems(input.asanaResult.data), "task")}`
      : "Asana is unavailable"
  ];

  return `${parts.join(", ")}.`;
}

function formatOneTimeDigestWatchouts(input: {
  gmailResult: ToolExecutionResult;
  calendarResult: ToolExecutionResult;
  asanaResult: ToolExecutionResult;
}): string[] {
  return [
    input.gmailResult.ok
      ? null
      : `Gmail: ${
          input.gmailResult.userMessage ??
          "I couldn't load recent inbox threads for this one-time digest."
        }`,
    input.calendarResult.ok
      ? null
      : `Calendar: ${
          input.calendarResult.userMessage ??
          "I couldn't load today's calendar for this one-time digest."
        }`,
    input.asanaResult.ok
      ? null
      : `Asana: ${
          input.asanaResult.userMessage ?? "I couldn't load open My Tasks for this one-time digest."
        }`
  ].filter((watchout): watchout is string => Boolean(watchout));
}

function countItems(data: unknown): number {
  return Array.isArray(data) ? data.length : 0;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function previousDigestSourceFailed(previous: string, sourcePatterns: RegExp[]): boolean {
  const sourcePattern = sourcePatterns.map((pattern) => pattern.source).join("|");
  const failurePattern =
    /\b(?:didn'?t load|did not load|couldn'?t|could not|was unavailable|were unavailable|unavailable|failed|missing|unable|reconnect|permission|auth|resolution issue)\b/i;
  const sourceAfterFailure = new RegExp(
    `\\b(?:couldn'?t|could not|unable to|failed to)\\s+(?:load|reach|pull|read|access|complete)[^.\\n]{0,40}(?:${sourcePattern})\\b`,
    "i"
  );
  if (sourceAfterFailure.test(previous)) return true;

  const segments = previous
    .split(/[.;\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.some((segment) => {
    const labeledSourceFailure = new RegExp(
      `^(?:[-*•]\\s*)?(?:${sourcePattern})\\s*:\\s*.*\\b(?:couldn'?t|could not|unavailable|failed|missing|unable|reconnect|permission|auth|resolution issue)\\b`,
      "i"
    );
    if (labeledSourceFailure.test(segment)) return true;

    const failureMatch = failurePattern.exec(segment);
    if (!failureMatch || failureMatch.index === undefined) return false;

    const sourceRegex = new RegExp(`(?:${sourcePattern})`, "gi");
    for (const sourceMatch of segment.matchAll(sourceRegex)) {
      if (sourceMatch.index === undefined || sourceMatch.index > failureMatch.index) continue;
      const between = segment.slice(sourceMatch.index + sourceMatch[0].length, failureMatch.index);
      if (!/\b(?:loaded|available|worked|succeeded|included|snapshot|led)\b/i.test(between)) {
        return true;
      }
    }

    return false;
  });
}

function formatGmailRetrySnapshot(data: unknown): string {
  const threads = Array.isArray(data) ? (data as GmailThreadSummary[]) : [];
  if (!threads.length) {
    return "No recent inbox threads found.";
  }

  const lines = threads.slice(0, 10).map((thread, index) => {
    const subject = thread.subject?.trim() || "(No subject)";
    const from = thread.from?.trim() ? ` from ${thread.from.trim()}` : "";
    const date = thread.date?.trim() ? ` at ${thread.date.trim()}` : "";
    const snippet = thread.snippet?.trim() ? `: ${thread.snippet.trim()}` : "";
    return `${index + 1}. ${subject}${from}${date}${snippet}`;
  });

  return `Found ${threads.length} recent inbox ${threads.length === 1 ? "thread" : "threads"}.\n${lines.join("\n")}`;
}

function lastAssistantMessage(history: ResponseInputItem[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role !== "assistant") continue;
    const text = textFromResponseInputItem(item);
    if (text) return text;
  }
  return null;
}

function textFromResponseInputItem(item: ResponseInputItem): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.output_text === "string") return part.output_text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isResponsePreferenceOnlyMessage(
  text: string,
  preferences: AssistantResponsePreferences
): boolean {
  if (!Object.keys(preferences).length) return false;
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  const hasPreferenceRequest =
    /\b(from now on|for future|always|use .* replies|set your|change your|style|tone|voice|vibe|personality|talk like|sound like|respond like|reply like|no\s+em\s*dashes?|no\s+emdashes?|avoid\s+em\s*dashes?|avoid\s+emdashes?|no\s+casual\s+dashes?|avoid\s+casual\s+dashes?|dont\s+use\s+-|don't\s+use\s+-|do\s+not\s+use\s+-)\b/.test(
      normalized
    ) ||
    /\b(?:be|make|keep)\s+(?:more\s+)?(?:concise|brief|short|detailed|direct|friendly|formal|casual|warm|professional|calm|playful|human[-\s]?like)\b/.test(
      normalized
    );
  if (!hasPreferenceRequest) return false;

  return !/\b(calendar|email|gmail|asana|notion|drive|doc|docs|task|tasks|event|reminder|send|book|create|add|delete|trash|move|update|search|find|read|summarize|list|look up|why|what|when)\b/.test(
    normalized
  );
}

function formatResponsePreferenceAcknowledgement(
  preferences: AssistantResponsePreferences
): string {
  const parts = [
    typeof preferences.verbosity === "string" ? preferences.verbosity : undefined,
    typeof preferences.tone === "string" ? preferences.tone : undefined,
    typeof preferences.format === "string" ? preferences.format : undefined,
    preferences.minimalFollowUps === true ? "minimal follow-ups" : undefined,
    preferences.humanLike === true ? "more natural" : undefined,
    preferences.avoidEmDashes === true ? "no em dashes" : undefined,
    preferences.avoidHyphenSeparators === true ? "no casual dash separators" : undefined,
    typeof preferences.style === "string" ? preferences.style : undefined,
    typeof preferences.personality === "string" ? preferences.personality : undefined
  ].filter((part): part is string => Boolean(part));

  if (!parts.length) return "Got it. I'll adjust my replies.";
  return `Got it. I'll keep replies ${parts.join(", ")}.`;
}

function buildImageInputItem(text: string, imageDataUrl: string): ResponseInputItem {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text
      },
      {
        type: "input_image",
        image_url: imageDataUrl,
        detail: "auto"
      }
    ]
  };
}

function inputWithPreparedCurrentTurn(
  history: ResponseInputItem[],
  preparedInput: PreparedInboundText
): ResponseInputItem[] {
  if (!preparedInput.modelInputItem) return history;

  const next = [...history];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.role === "user") {
      next[index] = preparedInput.modelInputItem;
      return next;
    }
  }

  return next.concat(preparedInput.modelInputItem);
}

function imageContextMemoryValue(
  context: PreparedImageContext,
  summary: string
): Record<string, string> {
  const value: Record<string, string> = {
    summary,
    mediaId: context.mediaId,
    mimeType: context.mimeType ?? context.downloadedMimeType,
    createdAt: new Date().toISOString()
  };
  if (context.caption) value.caption = context.caption;
  if (context.sha256) value.sha256 = context.sha256;
  return value;
}

function matchRecentGoogleDocDeleteRequest(
  text: string,
  memoryEntries: PromptMemoryEntry[]
): { documentId: string; title?: string } | null {
  const normalized = text.toLowerCase().replace(/[’]/g, "'").trim();
  const asksDelete = /\b(delete|trash|remove|get rid of)\b/.test(normalized);
  if (!asksDelete) return null;

  const doc = latestRecentGoogleDoc(memoryEntries);
  if (!doc) return null;

  if (/\b(google doc|doc|docs|document)\b/.test(normalized)) return doc;

  const pronounTarget =
    /\b(delete|trash|remove|get rid of)\s+(it|that|this|same one|current one)\b/.test(normalized) ||
    /\b(delete|trash|remove|get rid of)\s+(that|this|same|current)\b/.test(normalized);
  if (!pronounTarget) return null;

  return hasCompetingRecentActionTarget(memoryEntries) ? null : doc;
}

function latestRecentGoogleDoc(
  memoryEntries: PromptMemoryEntry[]
): { documentId: string; title?: string } | null {
  const entry = memoryEntries.find(
    (candidate) => candidate.key === "recent_google_doc" && !isStaleRecentMemory(candidate)
  );
  const value = entry?.value;
  if (!value || typeof value !== "object") return null;
  const documentId = (value as { documentId?: unknown }).documentId;
  if (typeof documentId !== "string" || !documentId) return null;
  const title = (value as { title?: unknown }).title;
  return {
    documentId,
    title: typeof title === "string" ? title : undefined
  };
}

function hasCompetingRecentActionTarget(memoryEntries: PromptMemoryEntry[]): boolean {
  return memoryEntries.some((entry) => {
    if (entry.key === "recent_google_doc") return false;
    if (!entry.key.startsWith("recent_")) return false;
    if (isStaleRecentMemory(entry)) return false;
    return [
      "recent_asana_tasks",
      "recent_calendar_events",
      "recent_drive_files",
      "recent_gmail_threads",
      "recent_notion_page",
      "recent_notion_pages",
      "recent_automations"
    ].includes(entry.key);
  });
}

function isStaleRecentMemory(entry: PromptMemoryEntry): boolean {
  return Date.now() - entry.updatedAt.getTime() > 1000 * 60 * 60 * 24 * 30;
}
