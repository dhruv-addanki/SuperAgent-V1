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
}

export function parseConfirmationIntent(text: string): ConfirmationIntent | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");
  if (["send", "send it"].includes(normalized)) return "SEND";
  if (["confirm", "book it", "create it"].includes(normalized)) return "CONFIRM";
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

export function getApprovalDecision(
  toolName: ToolName,
  input: unknown,
  latestUserMessage: string
): ApprovalDecision {
  if (toolName === "gmail_send_draft") {
    return {
      requiresApproval: true,
      confirmationKeyword: "SEND",
      confirmationMessage: "Draft ready. Reply SEND to send it.",
      reason: "sending_email"
    };
  }

  if (toolName === "calendar_create_event") {
    return {
      requiresApproval: true,
      confirmationKeyword: "CONFIRM",
      confirmationMessage: "Event ready. Reply CONFIRM to book it.",
      reason: "calendar_write"
    };
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

export function isReadOnlyModeWriteBlocked(): boolean {
  return env.GOOGLE_READ_ONLY_MODE;
}
