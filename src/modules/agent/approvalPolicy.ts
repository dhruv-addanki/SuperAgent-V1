import crypto from "node:crypto";
import { PendingActionStatus, type PendingAction, type PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { pendingActionExpiry } from "../../lib/time";
import type { ToolName } from "../../schemas/toolSchemas";
import { formatAutomationConfirmation } from "../automation/automationService";
import { isValidTimezone, normalizeAutomationSchedule } from "../automation/schedule";

export type ConfirmationIntent = "SEND" | "CONFIRM" | "CANCEL";

export interface ApprovalDecision {
  requiresApproval: boolean;
  confirmationKeyword?: Exclude<ConfirmationIntent, "CANCEL">;
  confirmationMessage?: string;
  reason?: string;
}

export interface PendingToolPayload {
  toolName: ToolName;
  input: unknown;
  confirmationKeyword: Exclude<ConfirmationIntent, "CANCEL">;
  summary?: string;
  context?: Record<string, unknown>;
}

export function parseConfirmationIntent(text: string): ConfirmationIntent | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");
  if (["send", "send it"].includes(normalized) || /^yes\b.*\bsend it\b/.test(normalized)) {
    return "SEND";
  }
  if (
    [
      "confirm",
      "book it",
      "create it",
      "go ahead",
      "do it",
      "do that",
      "ok",
      "okay",
      "yes",
      "sure"
    ].includes(normalized) ||
    /^yes\b.*\b(confirm|book it|create it)\b/.test(normalized)
  ) {
    return "CONFIRM";
  }
  if (["cancel", "stop", "never mind", "nevermind"].includes(normalized)) return "CANCEL";
  return null;
}

export function userClearlyRequestedDocCreation(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(create|make|start|write|draft)\b/.test(normalized) &&
    /\b(google doc|doc|document)\b/.test(normalized)
  );
}

export function userClearlyRequestedCalendarWrite(text: string): boolean {
  const normalized = text.toLowerCase();
  const actionRequested =
    /\b(add|book|create|move|put|schedule|reschedule|remove|delete|cancel)\b/.test(normalized) ||
    /\bon my calendar\b/.test(normalized);
  const calendarContext =
    /\b(calendar|event|meeting|appointment|lunch|dinner|drive|trip|flight)\b/.test(normalized) ||
    /\bon my calendar\b/.test(normalized) ||
    /\b(that|it)\b/.test(normalized);

  return actionRequested && calendarContext;
}

export function getApprovalDecision(
  toolName: ToolName,
  input: unknown,
  _latestUserMessage: string
): ApprovalDecision {
  if (toolName === "gmail_send_draft") {
    return {
      requiresApproval: true,
      confirmationKeyword: "SEND",
      confirmationMessage: "Draft ready. Reply send to send it, or tell me what to tweak.",
      reason: "sending_email"
    };
  }

  if (toolName === "automation_create") {
    const automationInput = input as {
      name?: string;
      prompt?: string;
      schedule?: unknown;
      timezone?: string;
    };
    const timezone =
      automationInput.timezone && isValidTimezone(automationInput.timezone)
        ? automationInput.timezone
        : "the user's timezone";
    let confirmationMessage =
      "Create this scheduled automation? Reply yes to create it, or cancel.";
    try {
      if (
        automationInput.prompt &&
        typeof timezone === "string" &&
        timezone !== "the user's timezone"
      ) {
        confirmationMessage = formatAutomationConfirmation({
          name: automationInput.name,
          prompt: automationInput.prompt,
          schedule: normalizeAutomationSchedule(automationInput.schedule),
          timezone
        });
      }
    } catch {
      confirmationMessage =
        "I need a clear recurring schedule with an exact time before I can create that automation.";
    }

    return {
      requiresApproval: true,
      confirmationKeyword: "CONFIRM",
      confirmationMessage,
      reason: "scheduled_automation_create"
    };
  }

  if (toolName === "calendar_create_event" || toolName === "calendar_update_event") {
    return { requiresApproval: false };
  }

  if (toolName === "calendar_delete_event") {
    return { requiresApproval: false };
  }

  if (toolName === "asana_bulk_update_tasks") {
    const taskGids =
      input &&
      typeof input === "object" &&
      Array.isArray((input as { taskGids?: unknown }).taskGids)
        ? ((input as { taskGids: unknown[] }).taskGids.filter(
            (taskGid): taskGid is string => typeof taskGid === "string"
          ) as string[])
        : [];
    const preview = formatAsanaBulkTaskPreview(input, taskGids);

    return {
      requiresApproval: true,
      confirmationKeyword: "CONFIRM",
      confirmationMessage: [
        `Complete ${taskGids.length} Asana task${taskGids.length === 1 ? "" : "s"}?`,
        ...preview.slice(0, 10),
        taskGids.length > 10 ? `...and ${taskGids.length - 10} more` : undefined,
        "Reply yes to confirm, or cancel."
      ]
        .filter(Boolean)
        .join("\n"),
      reason: "asana_bulk_completion"
    };
  }

  return { requiresApproval: false };
}

function formatAsanaBulkTaskPreview(input: unknown, taskGids: string[]): string[] {
  const previewItems =
    input &&
    typeof input === "object" &&
    Array.isArray((input as { taskPreview?: unknown }).taskPreview)
      ? (input as { taskPreview: unknown[] }).taskPreview
      : [];
  const previewByGid = new Map<string, { name?: string; projectName?: string; dueOn?: string }>();

  for (const item of previewItems) {
    if (!item || typeof item !== "object") continue;
    const record = item as {
      taskGid?: unknown;
      name?: unknown;
      projectName?: unknown;
      dueOn?: unknown;
    };
    if (typeof record.taskGid !== "string") continue;
    previewByGid.set(record.taskGid, {
      name: typeof record.name === "string" ? record.name : undefined,
      projectName: typeof record.projectName === "string" ? record.projectName : undefined,
      dueOn: typeof record.dueOn === "string" ? record.dueOn : undefined
    });
  }

  return taskGids.map((taskGid, index) => {
    const preview = previewByGid.get(taskGid);
    const name = preview?.name ?? `Task ${index + 1}`;
    const details = [preview?.projectName, preview?.dueOn ? `due ${preview.dueOn}` : undefined]
      .filter(Boolean)
      .join(" • ");
    return `- ${name}${details ? ` (${details})` : ""}`;
  });
}

export async function createPendingAction(
  prisma: PrismaClient,
  input: {
    userId: string;
    conversationId: string;
    actionType: string;
    payload: PendingToolPayload;
  }
): Promise<PendingAction> {
  return prisma.pendingAction.create({
    data: {
      userId: input.userId,
      conversationId: input.conversationId,
      actionType: input.actionType,
      payload: input.payload as any,
      approvalCode: crypto.randomUUID(),
      expiresAt: pendingActionExpiry()
    }
  });
}

export async function resolvePendingActionFromConversation(
  prisma: Pick<PrismaClient, "pendingAction">,
  userId: string,
  conversationId: string,
  now = new Date()
): Promise<PendingAction | null> {
  await prisma.pendingAction.updateMany({
    where: {
      userId,
      conversationId,
      status: PendingActionStatus.PENDING,
      expiresAt: { lte: now }
    },
    data: {
      status: PendingActionStatus.EXPIRED
    }
  });

  return prisma.pendingAction.findFirst({
    where: {
      userId,
      conversationId,
      status: PendingActionStatus.PENDING,
      expiresAt: { gt: now }
    },
    orderBy: { createdAt: "desc" }
  });
}

export function expectedConfirmationForPayload(
  payload: unknown
): Exclude<ConfirmationIntent, "CANCEL"> {
  const parsed = payload as Partial<PendingToolPayload>;
  return parsed.confirmationKeyword === "SEND" ? "SEND" : "CONFIRM";
}

export function matchesPositiveConfirmation(
  intent: Exclude<ConfirmationIntent, "CANCEL">,
  expected: Exclude<ConfirmationIntent, "CANCEL">
): boolean {
  return (
    intent === expected ||
    (intent === "SEND" && expected === "CONFIRM") ||
    (intent === "CONFIRM" && expected === "SEND")
  );
}

export function buildPendingActionContext(pendingAction: PendingAction | null): string {
  if (!pendingAction) return "No pending actions.";

  const payload = pendingAction.payload as Partial<PendingToolPayload> | null;
  if (!payload?.toolName) return "A pending action exists, but its details are unavailable.";

  if (payload.toolName === "gmail_send_draft") {
    const subject =
      typeof payload.context?.subject === "string" ? payload.context.subject : undefined;
    const to = typeof payload.context?.to === "string" ? payload.context.to : undefined;
    const body = typeof payload.context?.body === "string" ? payload.context.body : undefined;
    const draftId =
      payload.input &&
      typeof payload.input === "object" &&
      typeof (payload.input as { draftId?: unknown }).draftId === "string"
        ? (payload.input as { draftId: string }).draftId
        : undefined;

    return [
      "Pending action: email draft available.",
      to ? `To: ${to}` : undefined,
      subject ? `Subject: ${subject}` : undefined,
      body ? `Body:\n${body}` : undefined,
      draftId ? `Draft ID: ${draftId}` : undefined,
      "If the user refers to 'the email', 'the draft', 'same as in email', or asks to send it, use this pending draft context.",
      "If the user asks to tweak, revise, rewrite, shorten, expand, or change the email, revise this draft."
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (
    payload.toolName === "calendar_create_event" ||
    payload.toolName === "calendar_update_event" ||
    payload.toolName === "calendar_delete_event" ||
    payload.toolName === "automation_create"
  ) {
    return [
      `Pending action: ${payload.toolName}.`,
      payload.summary ? `Summary: ${payload.summary}` : undefined,
      payload.input ? `Details: ${JSON.stringify(payload.input)}` : undefined
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `Pending action: ${payload.toolName}.`,
    payload.summary ? `Summary: ${payload.summary}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export function isReadOnlyModeWriteBlocked(): boolean {
  return env.READ_ONLY_MODE;
}
