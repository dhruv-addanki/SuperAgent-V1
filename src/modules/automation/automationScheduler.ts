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
  formatConversationContextForPrompt
} from "../agent/conversationContext";
import { getOrCreateWhatsAppConversation, persistMessage } from "../agent/conversationState";
import { runResponseLoop } from "../agent/responseLoop";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { ToolExecutor } from "../agent/toolExecutor";
import { WhatsAppService } from "../whatsapp/whatsappService";
import { AutomationService, type ClaimedAutomation } from "./automationService";

interface AutomationSchedulerOptions {
  pollIntervalSeconds?: number;
  batchSize?: number;
  workerId?: string;
  forceTextDelivery?: boolean;
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

      await persistMessage(this.prisma, {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        content: outputText
      });
      await this.sendAutomationMessage(automation.user, conversation, outputText);

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
  ) {
    const memoryEntries = await this.longTermMemory.getRecentEntriesForContext(user.id);
    const setupStatus = await this.setupStatusService.getStatus(user);
    const automationInput = [
      "Run this scheduled automation now.",
      `Automation name: ${automation.name}`,
      `Saved instructions: ${automation.prompt}`,
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

    return runResponseLoop({
      client: this.responsesClient,
      model: env.OPENAI_MODEL,
      instructions: [
        prompt,
        "Scheduled automation mode:",
        "- Only use read-only information tools.",
        "- Do not create drafts, send emails, write calendar events, update Asana, or write Notion/Docs.",
        "- If a requested source is unavailable, include that briefly in the digest.",
        "- For Asana planning based on the user's own work, use asana_list_my_tasks. Do not call asana_list_project_tasks unless you have a real projectGid from recent context or asana_list_projects."
      ].join("\n"),
      tools: buildToolDefinitions(true).filter(
        (tool) => typeof tool.name !== "string" || !tool.name.startsWith("automation_")
      ),
      input: [{ role: "user", content: automationInput }],
      executeTool: async (toolName, toolInput) => {
        if (
          !isToolName(toolName) ||
          !isReadOnlyTool(toolName) ||
          toolName.startsWith("automation_")
        ) {
          return Promise.resolve({
            ok: false,
            error: "AUTOMATION_WRITE_BLOCKED",
            userMessage: "Scheduled automations can only use read-only tools."
          });
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
      },
      maxToolRounds: env.MAX_TOOL_ROUNDS,
      continueAfterToolMessages: true
    });
  }

  private async sendAutomationMessage(
    user: User,
    conversation: Conversation,
    message: string
  ): Promise<void> {
    const safeMessage = normalizeAssistantMessageForUser(message);
    if (this.options.forceTextDelivery || (await this.hasRecentInboundMessage(user.id))) {
      await this.whatsappService.sendTextMessage(user.whatsappPhone, safeMessage);
      return;
    }

    if (!env.WHATSAPP_AUTOMATION_TEMPLATE_NAME) {
      throw new UserFacingError(
        "WhatsApp automation template missing",
        "WHATSAPP_TEMPLATE_REQUIRED",
        "WhatsApp needs an approved automation template for scheduled messages outside the 24-hour window."
      );
    }

    await this.whatsappService.sendTemplateMessage({
      to: user.whatsappPhone,
      templateName: env.WHATSAPP_AUTOMATION_TEMPLATE_NAME,
      languageCode: env.WHATSAPP_AUTOMATION_TEMPLATE_LANGUAGE,
      bodyParameters: [safeMessage]
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });
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
      await persistMessage(this.prisma, {
        conversationId: targetConversation.id,
        role: MessageRole.ASSISTANT,
        content: safeMessage
      });
      await this.sendAutomationMessage(user, targetConversation, safeMessage);
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

function formatAutomationDigest(name: string, body: string): string {
  const compactBody = stripRedundantDigestHeading(body.trim()) || "No summary was produced.";
  return `${name}\n\n${compactBody}`;
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
    safeKeys
      .filter((key) => inputObject[key] !== undefined)
      .map((key) => [key, inputObject[key]])
  );
}

function looksLikeAsanaGid(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^\d{3,}$/.test(value) || /^project_\d+$/.test(value);
}

function stripRedundantDigestHeading(body: string): string {
  return body.replace(/^\s*(?:[-*•]\s*)?(?:morning\s+)?digest\s*:?\s*/i, "").trim();
}
