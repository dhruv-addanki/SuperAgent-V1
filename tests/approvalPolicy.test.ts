import { PendingActionStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  getApprovalDecision,
  parseConfirmationIntent,
  resolvePendingActionFromConversation,
  userClearlyRequestedDocCreation
} from "../src/modules/agent/approvalPolicy";

describe("approval policy", () => {
  it("parses explicit confirmation intents", () => {
    expect(parseConfirmationIntent("SEND")).toBe("SEND");
    expect(parseConfirmationIntent("send it")).toBe("SEND");
    expect(parseConfirmationIntent("CONFIRM")).toBe("CONFIRM");
    expect(parseConfirmationIntent("book it")).toBe("CONFIRM");
    expect(parseConfirmationIntent("cancel")).toBe("CANCEL");
    expect(parseConfirmationIntent("sure")).toBeNull();
  });

  it("requires approval for high-risk tools", () => {
    expect(
      getApprovalDecision("gmail_send_draft", { draftId: "d1" }, "send it").requiresApproval
    ).toBe(true);
    expect(
      getApprovalDecision(
        "calendar_create_event",
        { title: "Lunch", start: "2026-04-24T17:00:00.000Z", end: "2026-04-24T18:00:00.000Z" },
        "schedule lunch"
      ).requiresApproval
    ).toBe(true);
  });

  it("allows explicit Google Doc creation without extra approval", () => {
    expect(userClearlyRequestedDocCreation("Create a Google Doc with these notes")).toBe(true);
    expect(
      getApprovalDecision(
        "docs_create_document",
        { title: "Notes", content: "hello" },
        "Create a Google Doc with these notes"
      ).requiresApproval
    ).toBe(false);
    expect(
      getApprovalDecision(
        "docs_create_document",
        { title: "Notes", content: "hello" },
        "these are notes"
      ).requiresApproval
    ).toBe(true);
  });

  it("expires old pending actions and returns the newest active one", async () => {
    const now = new Date("2026-04-20T12:00:00.000Z");
    const actions = [
      {
        id: "old",
        userId: "u1",
        conversationId: "c1",
        status: PendingActionStatus.PENDING,
        expiresAt: new Date("2026-04-20T11:59:00.000Z"),
        createdAt: new Date("2026-04-20T11:00:00.000Z")
      },
      {
        id: "active",
        userId: "u1",
        conversationId: "c1",
        status: PendingActionStatus.PENDING,
        expiresAt: new Date("2026-04-20T12:30:00.000Z"),
        createdAt: new Date("2026-04-20T12:00:00.000Z")
      }
    ];

    const prisma = {
      pendingAction: {
        updateMany: vi.fn(async () => {
          actions[0]!.status = PendingActionStatus.EXPIRED;
        }),
        findFirst: vi.fn(
          async () =>
            actions
              .filter(
                (action) =>
                  action.userId === "u1" &&
                  action.conversationId === "c1" &&
                  action.status === PendingActionStatus.PENDING &&
                  action.expiresAt > now
              )
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        )
      }
    };

    const result = await resolvePendingActionFromConversation(prisma as any, "u1", "c1", now);
    expect(result?.id).toBe("active");
    expect(actions[0]!.status).toBe(PendingActionStatus.EXPIRED);
  });
});
