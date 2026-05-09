import crypto from "node:crypto";
import { clearInterval, setInterval } from "node:timers";
import {
  AutomationRunStatus,
  MessageRole,
  type Automation,
  type Conversation,
  type PrismaClient,
  type User
} from "@prisma/client";
import { subHours } from "date-fns";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { ResponsesClient } from "../../lib/openaiClient";
import { serializeError, UserFacingError, userMessageForError } from "../../lib/errors";
import { normalizeAssistantMessageForUser } from "../../lib/messageText";
import { buildToolDefinitions, isReadOnlyTool, isToolName } from "../../schemas/toolSchemas";
import { AsanaTokenService } from "../asana/tokenService";
import { GoogleTokenService } from "../google/tokenService";
import { NotionTokenService } from "../notion/tokenService";
import { LongTermMemory } from "../memory/longTermMemory";
import { SetupStatusService, setupStatusProfileLines } from "../agent/setupStatusService";
import {
  buildConversationContext,
  formatConversationContextForPrompt,
  type PromptMemoryEntry
} from "../agent/conversationContext";
import { getOrCreateWhatsAppConversation, persistMessage } from "../agent/conversationState";
import { runResponseLoop } from "../agent/responseLoop";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { ToolExecutor, type ToolExecutionResult } from "../agent/toolExecutor";
import { WhatsAppService } from "../whatsapp/whatsappService";
import { AutomationService, type ClaimedAutomation } from "./automationService";
import {
  buildDailyBriefingSnapshot,
  formatDailyBriefingSnapshotForPrompt,
  lastDailyBriefingDebugMemoryValue
} from "./dailyBriefing";
import { calendarOverviewWindow } from "../agent/calendarReadShortcut";
import {
  asanaTaskRefsFromSummaries,
  buildAssistantMessageRawPayload,
  type AsanaAssistantTaskRef,
  type AssistantDeliveryMetadata
} from "../agent/asanaMessageRefs";
import type { AsanaTaskSummary } from "../asana/asanaTypes";

interface AutomationSchedulerOptions {
  pollIntervalSeconds?: number;
  batchSize?: number;
  workerId?: string;
  forceTextDelivery?: boolean;
}

interface AutomationPromptResult {
  assistantMessage: string;
  asanaTaskRefs: AsanaAssistantTaskRef[];
}

interface AutomationDataSnapshot {
  sections: string[];
  asanaTaskRefs: AsanaAssistantTaskRef[];
}

export class AutomationScheduler {
  private readonly automationService: AutomationService;
  private readonly toolExecutor: ToolExecutor;
  private readonly longTermMemory: LongTermMemory;
  private readonly setupStatusService: SetupStatusService;
  private readonly pollIntervalSeconds: number;
  private readonly batchSize: number;
  private readonly workerId: string;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly responsesClient: ResponsesClient,
    private readonly whatsappService: WhatsAppService,
    private readonly options: AutomationSchedulerOptions = {}
  ) {
    this.automationService = new AutomationService(prisma);
    this.toolExecutor = new ToolExecutor(
      prisma,
      new GoogleTokenService(prisma),
      new AsanaTokenService(prisma),
      new NotionTokenService(prisma)
    );
    this.longTermMemory = new LongTermMemory(prisma);
    this.setupStatusService = new SetupStatusService(prisma);
    this.pollIntervalSeconds = options.pollIntervalSeconds ?? env.AUTOMATION_POLL_INTERVAL_SECONDS;
    this.batchSize = options.batchSize ?? env.AUTOMATION_BATCH_SIZE;
    this.workerId = options.workerId ?? `automation-${process.pid}-${crypto.randomUUID()}`;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runDueOnce().catch((error) => {
        logger.error({ error }, "Scheduled automation poll failed");
      });
    }, this.pollIntervalSeconds * 1000);
    this.timer.unref?.();

    void this.runDueOnce().catch((error) => {
      logger.error({ error }, "Initial scheduled automation poll failed");
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runDueOnce(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const automations = await this.automationService.claimDueAutomations({
        now,
        batchSize: this.batchSize,
        workerId: this.workerId
      });

      for (const automation of automations) {
        await this.runClaimedAutomation(automation);
      }

      return automations.length;
    } finally {
      this.running = false;
    }
  }

  private async runClaimedAutomation(automation: ClaimedAutomation): Promise<void> {
    const run = await this.prisma.automationRun.create({
      data: {
        automationId: automation.id,
        scheduledFor: automation.nextRunAt,
        status: AutomationRunStatus.RUNNING
      }
    });

    let outputText: string | undefined;
    try {
      const conversation =
        automation.conversation ??
        (await getOrCreateWhatsAppConversation(this.prisma, automation.userId));
      const result = await this.executeAutomationPrompt(automation, automation.user, conversation);
      outputText = normalizeAssistantMessageForUser(
        formatAutomationDigest(automation.name, result.assistantMessage)
      );

      const delivery = await this.sendAutomationMessage(automation.user, conversation, outputText);
      await persistMessage(this.prisma, {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        content: outputText,
        rawPayload: buildAssistantMessageRawPayload({
          source: "automation_digest",
          delivery,
          asanaTaskRefs: result.asanaTaskRefs
        })
      });

      await this.automationService.markRunSuccess({
        automation,
        runId: run.id,
        outputText
      });
    } catch (error) {
      const errorMessage = userMessageForError(error);
      const failureText = normalizeAssistantMessageForUser(
        `Automation "${automation.name}" failed: ${errorMessage}`
      );
      await this.trySendFailure(automation.user, automation.conversation, failureText);
      await this.automationService.markRunFailed({
        automation,
        runId: run.id,
        outputText,
        errorMessage: serializeError(error)
      });
    }
  }

  private async executeAutomationPrompt(
    automation: Automation,
    user: User,
    conversation: Conversation
  ): Promise<AutomationPromptResult> {
    const setupStatus = await this.setupStatusService.getStatus(user);
    const memoryEntries = filterAutomationContextMemoryEntries(
      await this.longTermMemory.getRecentEntriesForContext(user.id)
    );
    const preloadedData = await this.buildAutomationDataSnapshot(
      automation,
      user,
      conversation,
      memoryEntries
    );
    const automationInput = [
      "Run this scheduled automation now.",
      `Automation name: ${automation.name}`,
      `Saved instructions: ${automation.prompt}`,
      preloadedData.sections.length
        ? ["Preloaded read-only data for this run:", ...preloadedData.sections].join("\n\n")
        : "No preloaded data was available for this run.",
      "Return one compact WhatsApp digest. Do not ask follow-up questions unless the automation cannot run."
    ].join("\n");
    const conversationContext = buildConversationContext({
      latestUserMessage: automation.prompt,
      memoryEntries,
      pendingAction: null,
      pendingActionSummary: "No pending actions.",
      userProfile: setupStatusProfileLines(setupStatus, user.timezone)
    });
    const prompt = buildSystemPrompt({
      timezone: automation.timezone || user.timezone,
      conversationContext: formatConversationContextForPrompt(conversationContext),
      readOnlyMode: true,
      nowIso: new Date().toISOString()
    });

    const result = await runResponseLoop({
      client: this.responsesClient,
      model: env.OPENAI_MODEL,
      instructions: buildScheduledAutomationInstructions(prompt),
      tools: buildToolDefinitions(true).filter(
        (tool) => typeof tool.name !== "string" || !tool.name.startsWith("automation_")
      ),
      input: [{ role: "user", content: automationInput }],
      executeTool: async (toolName, toolInput) => {
        return this.executeReadOnlyAutomationTool(
          automation,
          user,
          conversation,
          toolName,
          toolInput
        );
      },
      maxToolRounds: env.MAX_TOOL_ROUNDS,
      continueAfterToolMessages: true
    });
    return {
      assistantMessage: result.assistantMessage,
      asanaTaskRefs: preloadedData.asanaTaskRefs
    };
  }

  private async buildAutomationDataSnapshot(
    automation: Automation,
    user: User,
    conversation: Conversation,
    memoryEntries: PromptMemoryEntry[]
  ): Promise<AutomationDataSnapshot> {
    const requestText = `${automation.name}\n${automation.prompt}`.toLowerCase();
    const sections: string[] = [];
    let asanaTaskRefs: AsanaAssistantTaskRef[] = [];
    let gmailResult: ToolExecutionResult | null = null;
    let calendarResult: ToolExecutionResult | null = null;
    let asanaResult: ToolExecutionResult | null = null;

    if (/\b(email|emails|gmail|inbox|mail)\b/.test(requestText)) {
      gmailResult = await this.executeReadOnlyAutomationTool(
        automation,
        user,
        conversation,
        "gmail_search_threads",
        {
          query: "in:inbox newer_than:2d",
          maxResults: 15
        }
      );
    }

    if (/\b(calendar|schedule|agenda|events?)\b/.test(requestText)) {
      const window = calendarOverviewWindow("today", automation.timezone || user.timezone);
      calendarResult = await this.executeReadOnlyAutomationTool(
        automation,
        user,
        conversation,
        "calendar_list_events",
        {
          timeMin: window.timeMin,
          timeMax: window.timeMax,
          maxResults: 50
        }
      );
    }

    if (/\basana\b|\btasks?\b/.test(requestText)) {
      asanaResult = await this.executeReadOnlyAutomationTool(
        automation,
        user,
        conversation,
        "asana_list_my_tasks",
        {
          completed: false,
          limit: 50,
          sortBy: "due",
          sortDirection: "asc"
        }
      );
      if (asanaResult.ok) {
        asanaTaskRefs = asanaTaskRefsFromSummaries(
          (asanaResult.data as AsanaTaskSummary[] | undefined) ?? [],
          "automation My Tasks"
        );
      }
    }

    const briefingSnapshot = buildDailyBriefingSnapshot({
      gmailResult,
      calendarResult,
      asanaResult,
      memoryEntries,
      timezone: automation.timezone || user.timezone
    });
    sections.push(formatDailyBriefingSnapshotForPrompt(briefingSnapshot));
    await this.rememberLastDailyBriefingDebug(user.id, briefingSnapshot);

    return { sections, asanaTaskRefs };
  }

  private async rememberLastDailyBriefingDebug(
    userId: string,
    snapshot: ReturnType<typeof buildDailyBriefingSnapshot>
  ): Promise<void> {
    const delegate = (this.prisma as any).memoryEntry;
    if (!delegate?.upsert) return;
    await delegate.upsert({
      where: { userId_key: { userId, key: "last_daily_briefing_debug" } },
      update: {
        value: lastDailyBriefingDebugMemoryValue(snapshot) as any,
        confidence: 1
      },
      create: {
        userId,
        key: "last_daily_briefing_debug",
        value: lastDailyBriefingDebugMemoryValue(snapshot) as any,
        confidence: 1
      }
    });
  }

  private async executeReadOnlyAutomationTool(
    automation: Automation,
    user: User,
    conversation: Conversation,
    toolName: string,
    toolInput: unknown
  ): Promise<ToolExecutionResult> {
    if (!isToolName(toolName) || !isReadOnlyTool(toolName) || toolName.startsWith("automation_")) {
      return {
        ok: false,
        error: "AUTOMATION_WRITE_BLOCKED",
        userMessage: "Scheduled automations can only use read-only tools."
      };
    }

    const routedCall = routeAutomationToolCall(toolName, toolInput);
    const routed = routedCall.toolName !== toolName || routedCall.input !== toolInput;
    logger.info(
      {
        automationId: automation.id,
        requestedToolName: toolName,
        routedToolName: routedCall.toolName,
        routed,
        inputSummary: summarizeAutomationToolInput(routedCall.input)
      },
      "Automation tool call"
    );

    const result = await this.toolExecutor.executeToolCall(
      routedCall.toolName,
      routedCall.input,
      {
        user,
        conversation,
        latestUserMessage: automation.prompt
      },
      { force: true }
    );
    if (result.ok) {
      logger.info(
        {
          automationId: automation.id,
          requestedToolName: toolName,
          routedToolName: routedCall.toolName
        },
        "Automation tool result"
      );
    } else {
      logger.warn(
        {
          automationId: automation.id,
          requestedToolName: toolName,
          routedToolName: routedCall.toolName,
          error: result.error,
          userMessage: result.userMessage
        },
        "Automation tool result"
      );
    }
    return result;
  }

  private async sendAutomationMessage(
    user: User,
    conversation: Conversation,
    message: string
  ): Promise<AssistantDeliveryMetadata> {
    const safeMessage = normalizeAssistantMessageForUser(message);
    if (this.options.forceTextDelivery || (await this.hasRecentInboundMessage(user.id))) {
      const result = await this.whatsappService.sendTextMessage(user.whatsappPhone, safeMessage);
      return { channel: "text", ...(result?.messageId ? { messageId: result.messageId } : {}) };
    }

    if (!env.WHATSAPP_AUTOMATION_TEMPLATE_NAME) {
      throw new UserFacingError(
        "WhatsApp automation template missing",
        "WHATSAPP_TEMPLATE_REQUIRED",
        "WhatsApp needs an approved automation template for scheduled messages outside the 24-hour window."
      );
    }

    const result = await this.whatsappService.sendTemplateMessage({
      to: user.whatsappPhone,
      templateName: env.WHATSAPP_AUTOMATION_TEMPLATE_NAME,
      languageCode: env.WHATSAPP_AUTOMATION_TEMPLATE_LANGUAGE,
      bodyParameters: [safeMessage]
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });
    return {
      channel: "template",
      ...(result?.messageId ? { messageId: result.messageId } : {})
    };
  }

  private async trySendFailure(
    user: User,
    conversation: Conversation | null,
    message: string
  ): Promise<void> {
    try {
      const safeMessage = normalizeAssistantMessageForUser(message);
      const targetConversation =
        conversation ?? (await getOrCreateWhatsAppConversation(this.prisma, user.id));
      const delivery = await this.sendAutomationMessage(user, targetConversation, safeMessage);
      await persistMessage(this.prisma, {
        conversationId: targetConversation.id,
        role: MessageRole.ASSISTANT,
        content: safeMessage,
        rawPayload: buildAssistantMessageRawPayload({
          source: "automation_failure",
          delivery
        })
      });
    } catch (error) {
      logger.warn({ error, userId: user.id }, "Failed to send automation failure notice");
    }
  }

  private async hasRecentInboundMessage(userId: string, now = new Date()): Promise<boolean> {
    const recentInbound = await this.prisma.message.findFirst({
      where: {
        role: MessageRole.USER,
        createdAt: { gte: subHours(now, 24) },
        conversation: {
          userId
        }
      },
      orderBy: { createdAt: "desc" }
    });
    return Boolean(recentInbound);
  }
}

export function formatAutomationDigest(name: string, body: string): string {
  const compactBody =
    capAutomationDigestLines(
      ensurePlanningDigestSections(
        name,
        stripEmptyDigestSections(
          normalizeDigestSectionLabels(
            stripWeakDigestTail(stripRedundantDigestHeading(body.trim()))
          )
        )
      )
    ) || "No summary was produced.";
  return normalizeAssistantMessageForUser(`${name}\n\n${compactBody}`);
}

export function buildScheduledAutomationInstructions(basePrompt: string): string {
  return [
    basePrompt,
    "Scheduled automation mode:",
    "- Only use read-only information tools.",
    "- Do not create drafts, send emails, write calendar events, update Asana, or write Notion/Docs.",
    "- If preloaded read-only data is included, use it as the primary source and do not repeat the same read unless the data is missing or clearly insufficient.",
    "- The preloaded Daily briefing intelligence section is already filtered and scored by backend rules. Do not resurrect suppressed facts, excluded calendars, read/low-signal emails, all-day task-like calendar items, or low-priority duplicate/test tasks.",
    "- Use score reasons to explain importance. A stale due date alone is not importance.",
    "- When a selected email, event, and task appear linked, combine them into one concrete next action instead of listing disconnected facts.",
    "- If structured conversation context conflicts with preloaded read-only data, trust the preloaded data for this run.",
    "- Write the digest as a compact command center for starting the day, with the practical structure of a morning briefing.",
    "- Target 12 to 18 WhatsApp-friendly lines. You may go slightly longer for real conflicts, important email, or source failures.",
    "- Use these section labels when relevant: At a glance, Schedule, Email, Asana, Focus plan, Action items, Further prompts.",
    "- Never output Watchouts. Convert risks, conflicts, source failures, and time-sensitive items into concrete Action items.",
    "- Never output an empty section label. If there are no concrete actions, omit Action items. If there are no exact suggested commands, omit Further prompts.",
    "- For daily planning digests, always include Focus plan when at least one source loaded successfully.",
    "- For daily planning digests, Action items must contain concrete next actions, not just a heading.",
    "- For daily planning digests, Further prompts should contain 3 exact quoted commands unless the automation could not run.",
    "- Start with At a glance: one line summarizing the day, urgency, conflicts, and top focus.",
    "- Keep Schedule short. Include key events and conflicts, not every detail when the day is busy.",
    "- Use Email for urgent or important threads first, then newsletters/promos only as a compact rollup when useful.",
    "- Use Asana for My Tasks priorities and stale/overdue task clusters. Do not treat stale due dates as priority by themselves.",
    "- Keep Focus plan realistic and integrated across calendar, email, and Asana. Prefer 2 or 3 time blocks or priorities.",
    "- Use Action items for concrete next actions the user should take today. Include source-retry actions here if Gmail, Calendar, or Asana failed.",
    "- End with Further prompts only when useful, with 1 to 3 exact reply commands in quotes.",
    "- If you include Further prompts, it must contain at least one quoted command on the following lines.",
    '- Suggested commands must be actions the user can send after the digest, such as "Move office hours to another slot", "Draft a reply to the Okta email", or "Create a calendar block for the Chase call".',
    "- Scheduled runs stay read-only. Never claim you already performed a suggested follow-up action.",
    '- Avoid overconfident priority claims. Prefer wording like "I\'d prioritize" or "Good candidates".',
    "- For Asana planning based on the user's own work, use asana_list_my_tasks. Do not call asana_list_project_tasks unless you have a real projectGid from recent context or asana_list_projects."
  ].join("\n");
}

export function filterAutomationContextMemoryEntries<T extends { key: string }>(entries: T[]): T[] {
  return entries.filter((entry) => !entry.key.startsWith("recent_"));
}

function routeAutomationToolCall(
  toolName: string,
  input: unknown
): { toolName: string; input: unknown } {
  if (toolName !== "asana_list_project_tasks" && toolName !== "asana_list_my_tasks") {
    return { toolName, input };
  }

  const inputObject = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (!inputObject.projectGid || looksLikeAsanaGid(inputObject.projectGid)) {
    return { toolName, input };
  }

  return {
    toolName: "asana_list_my_tasks",
    input: {
      completed: typeof inputObject.completed === "boolean" ? inputObject.completed : false,
      dueOn: inputObject.dueOn,
      dueBefore: inputObject.dueBefore,
      limit: typeof inputObject.limit === "number" ? inputObject.limit : 20,
      sortBy: inputObject.sortBy ?? "due",
      sortDirection: inputObject.sortDirection ?? "asc"
    }
  };
}

function summarizeAutomationToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const inputObject = input as Record<string, unknown>;
  const safeKeys = [
    "calendarId",
    "timeMin",
    "timeMax",
    "maxResults",
    "workspaceGid",
    "projectGid",
    "completed",
    "dueOn",
    "dueBefore",
    "limit",
    "sortBy",
    "sortDirection",
    "query"
  ];

  return Object.fromEntries(
    safeKeys.filter((key) => inputObject[key] !== undefined).map((key) => [key, inputObject[key]])
  );
}

function looksLikeAsanaGid(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^\d{3,}$/.test(value) || /^project_\d+$/.test(value);
}

function stripRedundantDigestHeading(body: string): string {
  return body.replace(/^\s*(?:[-*•]\s*)?(?:morning\s+)?digest\s*:?\s*/i, "").trim();
}

function stripWeakDigestTail(body: string): string {
  return body
    .replace(
      /\n{1,2}(?:if you want,?\s*)?i can (?:retry|run|check|help|try)[^\n]*(?:now|instead)?\.?\s*$/i,
      ""
    )
    .trim();
}

function normalizeDigestSectionLabels(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      const section = digestSectionName(line);
      if (section === "watchouts") return replaceDigestHeadingName(line, "Action items");
      if (section === "you can ask me to") return replaceDigestHeadingName(line, "Further prompts");
      return line;
    })
    .join("\n");
}

function stripEmptyDigestSections(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isDigestSectionHeading(line) && !hasSectionContent(lines, index)) {
      continue;
    }
    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ensurePlanningDigestSections(name: string, body: string): string {
  if (!isPlanningDigestName(name) || !body.trim()) return body;

  const withAsana = ensureAsanaSection(name, body);
  const withFocusPlan = digestHasSection(withAsana, "focus plan")
    ? withAsana
    : insertDigestSection(
        withAsana,
        "Focus plan",
        [
          "First block: handle the most time-sensitive email or admin item.",
          "Midday: work around fixed calendar events and protect transition time.",
          "Second block: move one Asana priority forward."
        ],
        ["action items", "further prompts"]
      );
  const withActionItems = digestHasSection(withFocusPlan, "action items")
    ? withFocusPlan
    : insertDigestSection(
        withFocusPlan,
        "Action items",
        [
          "Review the highest priority email and decide the next response or task.",
          "Pick one Asana task to move forward today.",
          "Use calendar gaps for one focused work block."
        ],
        ["further prompts"]
      );

  return ensureFurtherPromptCount(withActionItems);
}

function ensureAsanaSection(name: string, body: string): string {
  if (!/\basana\b/i.test(name) || digestHasSection(body, "asana")) return body;

  const unavailable =
    /\basana\b[^\n]*(?:unavailable|failed|couldn'?t|could not|unable|missing)/i.test(body);
  return insertDigestSection(
    body,
    "Asana",
    [
      unavailable
        ? "Asana was unavailable in this run; retry before relying on the task list."
        : "No Asana priorities were surfaced in this run. Ask for the task list if you want the raw view."
    ],
    ["focus plan", "action items", "further prompts"]
  );
}

function ensureFurtherPromptCount(body: string): string {
  const lines = body.split("\n");
  const headingIndex = lines.findIndex((line) => digestSectionName(line) === "further prompts");

  if (headingIndex < 0) {
    return insertDigestSection(
      body,
      "Further prompts",
      defaultFurtherPrompts([]).map((prompt) => prompt.replace(/^"|"$/g, "")),
      []
    );
  }

  const nextHeadingIndex = findNextDigestHeadingIndex(lines, headingIndex + 1);
  const sectionEnd = nextHeadingIndex >= 0 ? nextHeadingIndex : lines.length;
  const existingPrompts = lines
    .slice(headingIndex + 1, sectionEnd)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedExisting = new Set(existingPrompts.map(normalizePromptLine));
  const additions = defaultFurtherPrompts(existingPrompts)
    .filter((prompt) => !normalizedExisting.has(normalizePromptLine(prompt)))
    .slice(0, Math.max(0, 3 - existingPrompts.length));
  if (!additions.length) return body;

  const next = [...lines];
  next.splice(sectionEnd, 0, ...additions);
  return next.join("\n").trim();
}

function defaultFurtherPrompts(existingPrompts: string[]): string[] {
  const existing = existingPrompts.map(normalizePromptLine).join("\n");
  return [
    /\b(email|inbox|offer|thread|summarize)\b/.test(existing)
      ? null
      : '"Summarize the most important email"',
    /\b(asana|tasks?)\b/.test(existing) ? null : '"Show me today’s top 10 Asana tasks"',
    /\b(focus|plan|block|calendar)\b/.test(existing)
      ? null
      : '"Make a 2-hour focus plan from my calendar and Asana"'
  ].filter((prompt): prompt is string => Boolean(prompt));
}

function insertDigestSection(
  body: string,
  heading: string,
  items: string[],
  beforeSections: string[]
): string {
  const sectionLines = [`${heading}:`, ...items.map((item) => `• ${item}`)];
  const lines = body.split("\n");
  const insertIndex = beforeSections.length
    ? lines.findIndex((line) => {
        const section = digestSectionName(line);
        return Boolean(section && beforeSections.includes(section));
      })
    : -1;

  if (insertIndex < 0) {
    return [body.trim(), sectionLines.join("\n")].filter(Boolean).join("\n\n");
  }

  const next = [...lines];
  const previousLine = next[insertIndex - 1] ?? "";
  const prefix = previousLine.trim() ? [""] : [];
  next.splice(insertIndex, 0, ...prefix, ...sectionLines, "");
  return next
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function digestHasSection(body: string, sectionName: string): boolean {
  return body.split("\n").some((line) => digestSectionName(line) === sectionName);
}

function findNextDigestHeadingIndex(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (isDigestSectionHeading(lines[index] ?? "")) return index;
  }
  return -1;
}

function normalizePromptLine(line: string): string {
  return line
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .toLowerCase();
}

function isPlanningDigestName(name: string): boolean {
  return /\bdigest\b/i.test(name);
}

function isDigestSectionHeading(line: string): boolean {
  return digestSectionName(line) !== null;
}

function hasSectionContent(lines: string[], headingIndex: number): boolean {
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const candidate = lines[index] ?? "";
    if (isDigestSectionHeading(candidate)) return false;
    if (candidate.trim()) return true;
  }

  return false;
}

function digestSectionName(line: string): string | null {
  const normalized = line
    .trim()
    .replace(/^\*\s*/, "")
    .replace(/\s*\*:?$/, "")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();

  return /^(at a glance|schedule|email|asana|focus plan|action items|further prompts|watchouts|you can ask me to)$/.test(
    normalized
  )
    ? normalized
    : null;
}

function replaceDigestHeadingName(line: string, nextName: string): string {
  const trimmed = line.trim();
  const hasMarkdownBold = /^\*.*\*:?\s*$/.test(trimmed);
  const hasColon = /:\s*$/.test(trimmed);
  if (hasMarkdownBold) return `*${nextName}:*`;
  return `${nextName}${hasColon ? ":" : ""}`;
}

function capAutomationDigestLines(body: string): string {
  const lines = body
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, allLines) => line.trim() || (index > 0 && allLines[index - 1]?.trim()));
  const maxLines = 24;
  if (lines.length <= maxLines) return lines.join("\n").trim();

  const selected = new Set<number>();
  for (let index = 0; index < lines.length && selected.size < 18; index += 1) {
    selected.add(index);
  }

  for (let index = 0; index < lines.length && selected.size < maxLines; index += 1) {
    if (isHighValueDigestLine(lines[index] ?? "")) selected.add(index);
  }

  const actionSectionIndex = lines.findIndex((line) =>
    /^(?:you can ask me to|further prompts):?$/i.test(line.trim())
  );
  if (actionSectionIndex >= 0) {
    for (
      let index = actionSectionIndex;
      index < Math.min(lines.length, actionSectionIndex + 4) && selected.size < maxLines;
      index += 1
    ) {
      selected.add(index);
    }
  }

  return Array.from(selected)
    .sort((left, right) => left - right)
    .map((index) => lines[index])
    .join("\n")
    .trim();
}

function isHighValueDigestLine(line: string): boolean {
  return /\b(conflict|overlap|email|asana|focus plan|action items|further prompts|unavailable|failed|couldn'?t|urgent|time sensitive|you can ask me to)\b/i.test(
    line
  );
}
