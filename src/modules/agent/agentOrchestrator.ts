import {
  MessageRole,
  PendingActionStatus,
  type Conversation,
  type PendingAction,
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
  missingIntegrationsForRequired,
  setupStatusProfileLines,
  SetupStatusService,
  type SetupStatus
} from "./setupStatusService";
import { classifyIntentRoute, summarizeIntentRouteForLog, type IntentRoute } from "./intentRouter";
import {
  asanaTaskDueDate,
  formatAsanaTaskOverview,
  formatAsanaTodayAndLatestOpenReply,
  formatLatestAsanaTaskReply,
  formatScopedAsanaTaskList,
  lastFailedAsanaBulkRetryTaskList,
  lastVisibleAsanaTaskList,
  matchAmbiguousAsanaBulkCompleteRequest,
  matchAsanaBulkRetryRequest,
  matchAsanaDueTodayAndLatestOpenRequest,
  matchAsanaLatestTaskShortcut,
  matchAsanaListShortcut,
  matchAsanaListThenCompleteRequest,
  matchAsanaMultiCreateRequest,
  matchAsanaProjectsRequest,
  matchGenericAsanaOpenTasksRequest,
  matchGenericAsanaMyTasksRequest,
  matchListedAsanaBulkCompleteRequest,
  type AsanaListShortcut,
  resolveConcreteAsanaCompletionTarget
} from "./asanaReadShortcut";
import {
  calendarOverviewWindow,
  formatCalendarOverview,
  matchCalendarAllCalendarsFollowUpRequest,
  matchGenericCalendarOverviewRequest
} from "./calendarReadShortcut";
import type { AsanaProjectSummary, AsanaTaskSummary } from "../asana/asanaTypes";
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
      const pendingAction = await resolvePendingActionFromConversation(
        this.prisma,
        user.id,
        conversation.id
      );
      const pendingActionSummary = buildPendingActionContext(pendingAction);
      const intentRoute = classifyIntentRoute({
        text: preparedInput.text,
        hasModelInput: Boolean(preparedInput.modelInputItem),
        history,
        memoryEntries,
        timezone: user.timezone,
        hasPendingAction: Boolean(pendingAction),
        pendingActionSummary
      });
      const setupRequest = intentRoute.domains.includes("setup") && intentRoute.action === "setup";
      const integrationLinkRequest = setupRequest
        ? integrationLinkRequestForMessage(preparedInput.text, setupStatus)
        : null;
      const firstInteraction = isFirstInteraction(history);
      const shouldUseTextShortcuts = !preparedInput.modelInputItem;
      const appendSetupHint =
        firstInteraction &&
        !setupRequest &&
        !isGreetingOnly(preparedInput.text) &&
        !setupStatus.hasAnyConnected;
      const missingRequiredIntegrations = missingIntegrationsForRequired(
        intentRoute.requiredIntegrations,
        setupStatus
      );
      const chosenHandler = integrationLinkRequest
        ? "integration_link"
        : setupRequest
          ? "setup_status"
          : missingRequiredIntegrations.length
            ? "missing_integration_gate"
            : (intentRoute.shortcutCandidate ?? intentRoute.fallbackReason);
      logger.info(
        {
          route: summarizeIntentRouteForLog(intentRoute),
          chosenHandler,
          missingIntegrationDecision: missingRequiredIntegrations.map(
            (integration) => integration.key
          )
        },
        "Inbound intent route"
      );
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
      const runModelFallback = async (promptSuffix = ""): Promise<string> => {
        const conversationContext = buildConversationContext({
          latestUserMessage: preparedInput.text,
          memoryEntries,
          pendingAction,
          pendingActionSummary,
          userProfile: setupStatusProfileLines(setupStatus, user.timezone),
          intentRoute
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
          instructions: `${prompt}${promptSuffix}`,
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

        return result.assistantMessage;
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

      const asanaMultiCreate = shouldUseTextShortcuts
        ? matchAsanaMultiCreateRequest(preparedInput.text, user.timezone)
        : null;
      if (asanaMultiCreate) {
        const asanaStatus = setupStatus.integrations.find(
          (integration) => integration.key === "asana"
        );
        if (!integrationConnected(setupStatus, "asana") && asanaStatus) {
          await replyToUser(formatMissingIntegrationForWhatsApp(asanaStatus), {
            allowSetupHint: false
          });
          return;
        }

        const asanaMessage = await this.executeAsanaMultiCreate({
          tasks: asanaMultiCreate.tasks,
          user,
          conversation,
          latestUserMessage: preparedInput.text
        });

        if (hasNonAsanaCompoundWork(intentRoute)) {
          const remainingMessage = await runModelFallback(
            `\n\nBackend already created these Asana tasks from this request: ${asanaMessage}\nDo not call any Asana tools. Handle only the remaining non-Asana parts of the user's message.`
          );
          await replyToUser(compactReplySections([asanaMessage, remainingMessage]));
          return;
        }

        await replyToUser(asanaMessage);
        return;
      }

      const asanaListThenComplete = shouldUseTextShortcuts
        ? matchAsanaListThenCompleteRequest(
            preparedInput.text,
            history,
            memoryEntries,
            user.timezone
          )
        : null;
      if (asanaListThenComplete && integrationConnected(setupStatus, "asana")) {
        const listResult = await this.executeAsanaListShortcut({
          shortcut: asanaListThenComplete.listShortcut,
          user,
          conversation,
          latestUserMessage: preparedInput.text
        });
        const asanaMessage = await this.completeFreshAsanaListResult({
          result: listResult,
          shortcut: asanaListThenComplete.listShortcut,
          user,
          conversation,
          latestUserMessage: preparedInput.text
        });

        if (hasNonAsanaCompoundWork(intentRoute)) {
          const remainingMessage = await runModelFallback(
            `\n\nBackend already handled the Asana read and completion from this request: ${asanaMessage}\nDo not call any Asana tools. Handle only the remaining non-Asana parts of the user's message.`
          );
          await replyToUser(compactReplySections([asanaMessage, remainingMessage]));
          return;
        }

        await replyToUser(asanaMessage);
        return;
      }

      const concreteAsanaCompletion = shouldUseTextShortcuts
        ? resolveConcreteAsanaCompletionTarget(preparedInput.text, memoryEntries)
        : null;
      if (concreteAsanaCompletion && integrationConnected(setupStatus, "asana")) {
        if (concreteAsanaCompletion.status === "resolved") {
          const completionMessage = await this.executeConcreteAsanaCompletion({
            tasks: concreteAsanaCompletion.tasks,
            user,
            conversation,
            latestUserMessage: preparedInput.text
          });
          if (hasNonAsanaCompoundWork(intentRoute)) {
            const remainingMessage = await runModelFallback(
              `\n\nBackend already completed this Asana request: ${completionMessage}\nDo not call asana_update_task or asana_bulk_update_tasks for that completed target again. Handle only the remaining non-completion parts of the user's message.`
            );
            await replyToUser(compactReplySections([completionMessage, remainingMessage]));
            return;
          }
          await replyToUser(completionMessage);
          return;
        }

        if (hasNonAsanaCompoundWork(intentRoute)) {
          const remainingMessage = await runModelFallback(
            `\n\nThe Asana completion target is not concrete enough to execute: ${concreteAsanaCompletion.message}\nDo not complete Asana tasks. Handle only the remaining non-completion parts of the user's message.`
          );
          await replyToUser(
            compactReplySections([remainingMessage, `Asana: ${concreteAsanaCompletion.message}`])
          );
          return;
        }

        await replyToUser(concreteAsanaCompletion.message);
        return;
      }

      if (missingRequiredIntegrations.length > 1) {
        logger.info(
          {
            route: summarizeIntentRouteForLog(intentRoute),
            missingIntegrations: missingRequiredIntegrations.map((integration) => integration.key)
          },
          "Inbound intent route missing integrations"
        );
        await replyToUser(formatSetupStatusForWhatsApp(setupStatus), { allowSetupHint: false });
        return;
      }
      if (missingRequiredIntegrations.length === 1) {
        logger.info(
          {
            route: summarizeIntentRouteForLog(intentRoute),
            missingIntegrations: missingRequiredIntegrations.map((integration) => integration.key)
          },
          "Inbound intent route missing integration"
        );
        await replyToUser(formatMissingIntegrationForWhatsApp(missingRequiredIntegrations[0]!), {
          allowSetupHint: false
        });
        return;
      }

      const confirmationIntent = parseConfirmationIntent(preparedInput.text);
      if (confirmationIntent && (pendingAction || isHighConfidenceConfirmationRoute(intentRoute))) {
        const handled = await this.handleConfirmationIntent({
          intent: confirmationIntent,
          to: preparedInput.from,
          user,
          conversation,
          latestUserMessage: preparedInput.text,
          pendingAction
        });
        if (handled) return;
      }

      const projectFollowUpClarification = matchAmbiguousProjectFollowUpClarification(
        preparedInput.text,
        history
      );
      if (shouldUseTextShortcuts && projectFollowUpClarification) {
        await replyToUser(projectFollowUpClarification);
        return;
      }

      const asanaBulkRetry = matchAsanaBulkRetryRequest(preparedInput.text, memoryEntries);
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "asana_bulk_retry" &&
        asanaBulkRetry
      ) {
        const retryList = lastFailedAsanaBulkRetryTaskList(memoryEntries);
        if (!retryList?.tasks.length) {
          await replyToUser(
            retryList?.scopeLabel
              ? `The last Asana bulk attempt has no retryable task failures. ${retryList.scopeLabel}`
              : "The last Asana bulk attempt has no retryable task failures. Reload the task list before retrying."
          );
          return;
        }

        const result = await this.toolExecutor.executeToolCall(
          "asana_bulk_update_tasks",
          {
            taskGids: retryList.tasks.map((task) => task.taskGid),
            completed: true,
            source: "recent_list",
            taskPreview: retryList.tasks
          },
          {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }
        );
        await replyToUser(result.userMessage ?? "I staged the retry for those Asana tasks.");
        return;
      }

      const listedAsanaBulkComplete = matchListedAsanaBulkCompleteRequest(preparedInput.text);
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "asana_listed_bulk_complete" &&
        listedAsanaBulkComplete
      ) {
        const recentList = lastVisibleAsanaTaskList(memoryEntries);
        if (!recentList) {
          await replyToUser(
            "I don't have a recent Asana task list to apply that to. Ask me to show the tasks first."
          );
          return;
        }
        if (!recentList.tasks.length) {
          await replyToUser("The last Asana task list I showed had no tasks to complete.");
          return;
        }

        const result = await this.toolExecutor.executeToolCall(
          "asana_bulk_update_tasks",
          {
            taskGids: recentList.tasks.map((task) => task.taskGid),
            completed: true,
            source: "recent_list",
            taskPreview: recentList.tasks
          },
          {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }
        );
        await replyToUser(result.userMessage ?? "I staged completion for the listed Asana tasks.");
        return;
      }

      const oneTimeAutomationDigest = matchOneTimeAutomationDigestRequest(
        preparedInput.text,
        history
      );
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "one_time_morning_digest" &&
        oneTimeAutomationDigest
      ) {
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
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "missing_digest_retry" &&
        missingAutomationRetry
      ) {
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
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "ambiguous_asana_bulk_complete" &&
        ambiguousBulkComplete
      ) {
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
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "recent_google_doc_delete" &&
        recentGoogleDocToDelete
      ) {
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
        shouldUseTextShortcuts && intentRoute.shortcutCandidate === "calendar_overview"
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

      const asanaProjectsRequest = matchAsanaProjectsRequest(preparedInput.text);
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "asana_projects" &&
        asanaProjectsRequest
      ) {
        const result = await this.toolExecutor.executeToolCall(
          "asana_list_projects",
          {},
          {
            user,
            conversation,
            latestUserMessage: preparedInput.text
          }
        );

        if (!result.ok) {
          await replyToUser(
            result.userMessage ??
              "I couldn't list your Asana projects right now. Try again in a moment."
          );
          return;
        }

        await replyToUser(formatAsanaProjectsReply(result.data as AsanaProjectSummary[]));
        return;
      }

      if (shouldUseTextShortcuts && intentRoute.shortcutCandidate === "asana_project_tasks") {
        const projectName = routeEntityValue(intentRoute, "asana_project_name");
        if (projectName) {
          const result = await this.toolExecutor.executeToolCall(
            "asana_list_project_tasks",
            {
              projectName,
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
                "I couldn't load those Asana project tasks right now. Try again in a moment."
            );
            return;
          }

          await replyToUser(
            formatScopedAsanaTaskList((result.data as AsanaTaskSummary[] | undefined) ?? [], {
              label: "from project",
              emptyLabel: `I don't see open Asana tasks in ${projectName}.`,
              scopeName: projectName,
              emphasizeImportance: false
            })
          );
          return;
        }
      }

      const asanaTodayAndLatestOpen = matchAsanaDueTodayAndLatestOpenRequest(
        preparedInput.text,
        history,
        memoryEntries,
        user.timezone
      );
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "asana_today_and_latest_open" &&
        asanaTodayAndLatestOpen
      ) {
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
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "asana_latest_task" &&
        asanaLatestShortcut
      ) {
        const toolName =
          asanaLatestShortcut.scope === "project"
            ? "asana_list_project_tasks"
            : "asana_list_my_tasks";
        const result = await this.toolExecutor.executeToolCall(
          toolName,
          {
            ...(asanaLatestShortcut.project
              ? asanaLatestShortcut.project.projectGid
                ? { projectGid: asanaLatestShortcut.project.projectGid }
                : { projectName: asanaLatestShortcut.project.name }
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
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "asana_list" &&
        asanaListShortcut
      ) {
        const result = await this.executeAsanaListShortcut({
          shortcut: asanaListShortcut,
          user,
          conversation,
          latestUserMessage: preparedInput.text
        });

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
            emptyLabel: `I don't see ${asanaListShortcut.completed ? "completed" : "open"} Asana tasks ${asanaListShortcut.label}${asanaListShortcut.project ? ` in ${asanaListShortcut.project.name}` : ""}.`,
            scopeName: asanaListShortcut.project?.name,
            completed: asanaListShortcut.completed,
            displayLimit: asanaListShortcut.requestedLimit ?? 20,
            emphasizeImportance: asanaListShortcut.emphasizeImportance
          })
        );
        return;
      }

      const genericAsanaOpenTasks = matchGenericAsanaOpenTasksRequest(preparedInput.text);
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "asana_open_tasks" &&
        genericAsanaOpenTasks
      ) {
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
      if (
        shouldUseTextShortcuts &&
        intentRoute.shortcutCandidate === "asana_my_tasks" &&
        genericAsanaTaskOverview
      ) {
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

      await replyToUser(await runModelFallback());
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

  private async executeAsanaListShortcut(input: {
    shortcut: AsanaListShortcut;
    user: User;
    conversation: Conversation;
    latestUserMessage: string;
  }): Promise<ToolExecutionResult> {
    const toolName =
      input.shortcut.scope === "project" ? "asana_list_project_tasks" : "asana_list_my_tasks";
    return this.toolExecutor.executeToolCall(
      toolName,
      {
        ...(input.shortcut.project
          ? input.shortcut.project.projectGid
            ? { projectGid: input.shortcut.project.projectGid }
            : { projectName: input.shortcut.project.name }
          : {}),
        completed: input.shortcut.completed,
        dueOn: input.shortcut.dueOn,
        dueAfter: input.shortcut.dueAfter,
        dueBefore: input.shortcut.dueBefore,
        limit: input.shortcut.limit,
        sortBy: input.shortcut.sortBy,
        sortDirection: input.shortcut.sortDirection
      },
      {
        user: input.user,
        conversation: input.conversation,
        latestUserMessage: input.latestUserMessage
      }
    );
  }

  private async completeFreshAsanaListResult(input: {
    result: ToolExecutionResult;
    shortcut: AsanaListShortcut;
    user: User;
    conversation: Conversation;
    latestUserMessage: string;
  }): Promise<string> {
    if (!input.result.ok) {
      return (
        input.result.userMessage ??
        "I couldn't load the Asana tasks to complete. No tasks were changed."
      );
    }

    const tasks = ((input.result.data as AsanaTaskSummary[] | undefined) ?? []).filter(
      (task) => task.gid
    );
    if (!tasks.length) {
      return `No matching Asana tasks to complete${input.shortcut.project ? ` in ${input.shortcut.project.name}` : ""}.`;
    }
    if (tasks.length > 25) {
      return `That Asana query returned ${tasks.length} tasks. I can complete at most 25 at once, so no tasks were changed. Narrow the list or say complete the first 25 shown after listing it.`;
    }

    return this.executeConcreteAsanaCompletion({
      tasks: tasks.map((task) => ({
        taskGid: task.gid,
        name: task.name,
        projectName: task.projects?.[0]?.name,
        dueOn: task.dueOn
      })),
      user: input.user,
      conversation: input.conversation,
      latestUserMessage: input.latestUserMessage
    });
  }

  private async executeAsanaMultiCreate(input: {
    tasks: Array<{ name: string; dueOn?: string }>;
    user: User;
    conversation: Conversation;
    latestUserMessage: string;
  }): Promise<string> {
    const created: Array<{ name: string; dueOn?: string; assigneeName?: string }> = [];
    const failed: Array<{ name: string; message: string }> = [];

    for (const task of input.tasks) {
      const result = await this.toolExecutor.executeToolCall(
        "asana_create_task",
        task,
        {
          user: input.user,
          conversation: input.conversation,
          latestUserMessage: input.latestUserMessage
        },
        { force: true }
      );

      if (!result.ok) {
        failed.push({
          name: task.name,
          message: result.userMessage ?? "I couldn't create this Asana task."
        });
        continue;
      }

      const data = result.data as AsanaTaskSummary | undefined;
      created.push({
        name: data?.name ?? task.name,
        dueOn: data?.dueOn ?? task.dueOn,
        assigneeName: data?.assigneeName
      });
    }

    return formatAsanaMultiCreateMessage(created, failed);
  }

  private async executeConcreteAsanaCompletion(input: {
    tasks: Array<{ taskGid: string; name?: string; projectName?: string; dueOn?: string }>;
    user: User;
    conversation: Conversation;
    latestUserMessage: string;
  }): Promise<string> {
    if (input.tasks.length === 1) {
      const task = input.tasks[0]!;
      const result = await this.toolExecutor.executeToolCall(
        "asana_update_task",
        {
          taskGid: task.taskGid,
          completed: true
        },
        {
          user: input.user,
          conversation: input.conversation,
          latestUserMessage: input.latestUserMessage
        },
        { force: true }
      );
      if (!result.ok) {
        return result.userMessage ?? "I couldn't complete that Asana task.";
      }
      return formatConcreteAsanaCompletionMessage(input.tasks, result.data);
    }

    const result = await this.toolExecutor.executeToolCall(
      "asana_bulk_update_tasks",
      {
        taskGids: input.tasks.map((task) => task.taskGid),
        completed: true,
        source: "recent_list",
        taskPreview: input.tasks
      },
      {
        user: input.user,
        conversation: input.conversation,
        latestUserMessage: input.latestUserMessage
      },
      { force: true }
    );

    if (!result.ok) {
      return result.userMessage ?? "I couldn't complete those Asana tasks.";
    }

    return formatConcreteAsanaCompletionMessage(input.tasks, result.data);
  }

  private async handleConfirmationIntent(input: {
    intent: "SEND" | "CONFIRM" | "CANCEL";
    to: string;
    user: User;
    conversation: Conversation;
    latestUserMessage: string;
    pendingAction?: PendingAction | null;
  }): Promise<boolean> {
    const pending =
      input.pendingAction ??
      (await resolvePendingActionFromConversation(
        this.prisma,
        input.user.id,
        input.conversation.id
      ));

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

function isHighConfidenceConfirmationRoute(route: IntentRoute): boolean {
  return (
    route.confidence === "high" &&
    (route.action === "confirm" || route.action === "cancel" || route.action === "send")
  );
}

function routeEntityValue(route: IntentRoute, type: string): string | null {
  return route.entities.find((entity) => entity.type === type)?.value ?? null;
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

  const actionItems = formatOneTimeDigestActionItems(input);
  if (actionItems.length) {
    sections.push(
      ["Action items:", ...actionItems.map((actionItem) => `• ${actionItem}`)].join("\n")
    );
  }

  const furtherPrompts = formatOneTimeDigestFurtherPrompts(input);
  if (furtherPrompts.length) {
    sections.push(
      ["Further prompts:", ...furtherPrompts.map((prompt) => `"${prompt}"`)].join("\n")
    );
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

function formatOneTimeDigestActionItems(input: {
  gmailResult: ToolExecutionResult;
  calendarResult: ToolExecutionResult;
  asanaResult: ToolExecutionResult;
}): string[] {
  return [
    input.gmailResult.ok && countItems(input.gmailResult.data)
      ? "Scan the important inbox items first, especially security, billing, school, or deadline emails."
      : null,
    input.calendarResult.ok
      ? "Use the calendar gaps to place one Asana work block and one admin cleanup block."
      : null,
    input.asanaResult.ok && countItems(input.asanaResult.data)
      ? "Pick 1 to 2 Asana My Tasks to move forward today; treat stale due dates as triage signals, not automatic priority."
      : null,
    !input.gmailResult.ok
      ? `Retry or reconnect Gmail: ${
          input.gmailResult.userMessage ??
          "I couldn't load recent inbox threads for this one-time digest."
        }`
      : null,
    !input.calendarResult.ok
      ? `Retry or reconnect Calendar: ${
          input.calendarResult.userMessage ??
          "I couldn't load today's calendar for this one-time digest."
        }`
      : null,
    !input.asanaResult.ok
      ? `Retry or reconnect Asana: ${
          input.asanaResult.userMessage ?? "I couldn't load open My Tasks for this one-time digest."
        }`
      : null
  ].filter((actionItem): actionItem is string => Boolean(actionItem));
}

function formatOneTimeDigestFurtherPrompts(input: {
  gmailResult: ToolExecutionResult;
  calendarResult: ToolExecutionResult;
  asanaResult: ToolExecutionResult;
}): string[] {
  return [
    input.gmailResult.ok ? "Summarize just the important emails" : "Retry Gmail for the digest",
    input.asanaResult.ok ? "Show my top 10 oldest Asana tasks" : "Retry Asana for the digest",
    input.calendarResult.ok ? "Check my calendar for tomorrow" : "Retry Calendar for the digest"
  ].slice(0, 3);
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

function formatAsanaProjectsReply(projects: AsanaProjectSummary[]): string {
  if (!projects.length) return "I don't see any Asana projects in that workspace.";

  return [
    `Here are the Asana projects I can see:`,
    "",
    ...projects.slice(0, 25).map((project, index) => {
      const details = [project.teamName, project.archived ? "archived" : undefined]
        .filter(Boolean)
        .join(" • ");
      return `${index + 1}. ${project.name}${details ? ` (${details})` : ""}`;
    })
  ].join("\n");
}

function matchAmbiguousProjectFollowUpClarification(
  text: string,
  history: ResponseInputItem[]
): string | null {
  const normalized = text.toLowerCase().replace(/[’]/g, "'").trim();
  if (!/^(?:yes|yep|yeah|sure|ok|okay)(?:\s+(?:do|check)\s+that)?$/.test(normalized)) {
    return null;
  }

  const previous = lastAssistantText(history);
  if (!previous || !/\bspecific project\b/i.test(previous)) return null;

  const projects = extractOfferedProjectNames(previous);
  if (projects.length < 2) return null;

  return `Which project should I check: ${projects.join(" or ")}?`;
}

function lastAssistantText(history: ResponseInputItem[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role !== "assistant") continue;
    return typeof item.content === "string" ? item.content : null;
  }
  return null;
}

function extractOfferedProjectNames(text: string): string[] {
  const match = text.match(/\blike\s+([^.\n?]+)/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(/\s+or\s+|,\s*/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 4);
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

function integrationConnected(status: SetupStatus, key: "google" | "asana" | "notion"): boolean {
  return Boolean(
    status.integrations.find((integration) => integration.key === key && integration.connected)
  );
}

function hasNonAsanaCompoundWork(route: IntentRoute): boolean {
  return route.isCompound && route.domains.some((domain) => domain !== "asana");
}

function compactReplySections(sections: Array<string | undefined | null>): string {
  return sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section) && section !== "Done.")
    .join("\n\n");
}

function formatAsanaMultiCreateMessage(
  created: Array<{ name: string; dueOn?: string; assigneeName?: string }>,
  failed: Array<{ name: string; message: string }>
): string {
  const sections: string[] = [];
  if (created.length) {
    const dueDates = new Set(created.map((task) => task.dueOn).filter(Boolean));
    const sharedDue = dueDates.size === 1 ? Array.from(dueDates)[0] : undefined;
    sections.push(
      [
        `Created ${created.length} Asana task${created.length === 1 ? "" : "s"}${sharedDue ? ` due ${sharedDue}` : ""}:`,
        ...created.map((task) => {
          const details = [
            !sharedDue && task.dueOn ? `due ${task.dueOn}` : undefined,
            task.assigneeName ? `assignee ${task.assigneeName}` : undefined
          ]
            .filter(Boolean)
            .join(" • ");
          return `- ${task.name}${details ? ` (${details})` : ""}`;
        })
      ].join("\n")
    );
  }

  if (failed.length) {
    sections.push(
      [
        `Couldn't create ${failed.length} Asana task${failed.length === 1 ? "" : "s"}:`,
        ...failed.map((task) => `- ${task.name}: ${task.message}`)
      ].join("\n")
    );
  }

  return sections.join("\n\n") || "I couldn't identify any Asana tasks to create.";
}

function formatConcreteAsanaCompletionMessage(
  tasks: Array<{ taskGid: string; name?: string; projectName?: string; dueOn?: string }>,
  resultData: unknown
): string {
  const completedText = `Completed ${tasks.length} Asana task${tasks.length === 1 ? "" : "s"}`;
  const preview = formatAsanaCompletionPreview(tasks);
  const recurrenceNote = formatRecurringAsanaCompletionNote(tasks, resultData);
  return `${completedText}${preview ? `: ${preview}` : ""}.${recurrenceNote ? `\n${recurrenceNote}` : ""}`;
}

function formatAsanaCompletionPreview(
  tasks: Array<{ taskGid: string; name?: string; projectName?: string; dueOn?: string }>
): string {
  const visible = tasks.slice(0, 5).map((task) => {
    const details = [task.projectName, task.dueOn ? `due ${task.dueOn}` : undefined]
      .filter(Boolean)
      .join(" • ");
    return `${task.name ?? task.taskGid}${details ? ` (${details})` : ""}`;
  });
  if (tasks.length > visible.length) visible.push(`and ${tasks.length - visible.length} more`);
  return visible.join("; ");
}

function formatRecurringAsanaCompletionNote(
  originalTasks: Array<{ taskGid: string; name?: string; dueOn?: string }>,
  resultData: unknown
): string | null {
  const updatedTasks = extractUpdatedAsanaTasks(resultData);
  if (!updatedTasks.length) return null;

  const originalByGid = new Map(originalTasks.map((task) => [task.taskGid, task]));
  const rolledForward = updatedTasks.filter((task) => {
    const original = originalByGid.get(task.gid);
    if (!original) return false;
    return (
      task.completed === false ||
      (Boolean(original.dueOn) && Boolean(task.dueOn) && task.dueOn !== original.dueOn)
    );
  });

  if (!rolledForward.length) return null;
  const names = rolledForward
    .slice(0, 3)
    .map((task) => task.name)
    .join(", ");
  const suffix = rolledForward.length > 3 ? `, and ${rolledForward.length - 3} more` : "";
  const pronoun = rolledForward.length === 1 ? "it" : "them";
  return `Recurring note: ${names}${suffix} may still appear open because Asana rolled ${pronoun} to the next occurrence.`;
}

function extractUpdatedAsanaTasks(data: unknown): AsanaTaskSummary[] {
  if (!data || typeof data !== "object") return [];
  if ("gid" in data) return [data as AsanaTaskSummary];

  const updated = (data as { updated?: unknown }).updated;
  return Array.isArray(updated) ? (updated as AsanaTaskSummary[]) : [];
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
