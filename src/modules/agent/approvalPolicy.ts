import crypto from "node:crypto";
import { PendingActionStatus, type PendingAction, type PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { pendingActionExpiry } from "../../lib/time";
import type { ToolName } from "../../schemas/toolSchemas";

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
    ["confirm", "book it", "create it", "go ahead", "do it", "do that", "ok", "okay", "yes", "sure"].includes(normalized) ||
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

export function userClearlyRequestedEmailSend(text: string): boolean {
  const normalized = text.toLowerCase();
  if (/\bdraft\b/.test(normalized) && !/\bsend\b/.test(normalized)) {
    return false;
  }

  return /\bsend\b/.test(normalized);
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
  latestUserMessage: string
): ApprovalDecision {
  if (toolName === "gmail_send_draft") {
    if (userClearlyRequestedEmailSend(latestUserMessage)) {
      return { requiresApproval: false };
    }

    return {
      requiresApproval: true,
      confirmationKeyword: "CONFIRM",
      confirmationMessage: "Draft ready. Want me to send it?",
      reason: "sending_email_without_explicit_send"
    };
  }

  if (toolName === "calendar_create_event" || toolName === "calendar_update_event") {
    return { requiresApproval: false };
  }

  if (toolName === "calendar_delete_event") {
    return { requiresApproval: false };
  }

  if (toolName === "docs_create_document" && !userClearlyRequestedDocCreation(latestUserMessage)) {
    return {
      requiresApproval: true,
      confirmationKeyword: "CONFIRM",
      confirmationMessage: "Document ready. Reply CONFIRM to create it.",
      reason: "document_creation_not_explicit"
    };
  }

  return { requiresApproval: false };
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
  return intent === expected || (intent === "SEND" && expected === "CONFIRM") || (intent === "CONFIRM" && expected === "SEND");
}

export function buildPendingActionContext(pendingAction: PendingAction | null): string {
  if (!pendingAction) return "No pending actions.";

  const payload = pendingAction.payload as Partial<PendingToolPayload> | null;
  if (!payload?.toolName) return "A pending action exists, but its details are unavailable.";

  if (payload.toolName === "gmail_send_draft") {
    const subject = typeof payload.context?.subject === "string" ? payload.context.subject : undefined;
    const to = typeof payload.context?.to === "string" ? payload.context.to : undefined;
    const body = typeof payload.context?.body === "string" ? payload.context.body : undefined;
    const draftId =
      payload.input && typeof payload.input === "object" && typeof (payload.input as { draftId?: unknown }).draftId === "string"
        ? (payload.input as { draftId: string }).draftId
        : undefined;

    return [
      "Pending action: email draft available.",
      to ? `To: ${to}` : undefined,
      subject ? `Subject: ${subject}` : undefined,
      body ? `Body:\n${body}` : undefined,
      draftId ? `Draft ID: ${draftId}` : undefined,
      "If the user refers to 'the email', 'the draft', 'same as in email', or asks to send it, use this pending draft context."
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (
    payload.toolName === "calendar_create_event" ||
    payload.toolName === "calendar_update_event" ||
    payload.toolName === "calendar_delete_event"
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
  return env.GOOGLE_READ_ONLY_MODE;
}
