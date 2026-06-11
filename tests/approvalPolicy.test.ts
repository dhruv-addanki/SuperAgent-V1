import { PendingActionStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  buildPendingActionContext,
  createPendingAction,
  getApprovalDecision,
  matchesPositiveConfirmation,
  parseConfirmationIntent,
  resolvePendingActionFromConversation,
  userClearlyRequestedCalendarWrite,
  userClearlyRequestedDocCreation
} from "../src/modules/agent/approvalPolicy";

describe("approval policy", () => {
  it("parses explicit confirmation intents", () => {
    expect(parseConfirmationIntent("SEND")).toBe("SEND");
    expect(parseConfirmationIntent("send it")).toBe("SEND");
    expect(parseConfirmationIntent("CONFIRM")).toBe("CONFIRM");
    expect(parseConfirmationIntent("book it")).toBe("CONFIRM");
    expect(parseConfirmationIntent("Yes book it with my general calendar")).toBe("CONFIRM");
    expect(parseConfirmationIntent("go ahead")).toBe("CONFIRM");
    expect(parseConfirmationIntent("Do it")).toBe("CONFIRM");
    expect(parseConfirmationIntent("cancel")).toBe("CANCEL");
    expect(parseConfirmationIntent("sure")).toBe("CONFIRM");
  });

  it("treats natural positive replies as valid approval for pending sends", () => {
    expect(matchesPositiveConfirmation("CONFIRM", "SEND")).toBe(true);
    expect(matchesPositiveConfirmation("SEND", "CONFIRM")).toBe(true);
  });

  it("requires approval before sending a draft", () => {
    expect(
      getApprovalDecision("gmail_send_draft", { draftId: "d1" }, "draft an email to Brad").requiresApproval
    ).toBe(true);
    expect(
      getApprovalDecision(
        "gmail_send_draft",
        { draftId: "d1" },
        "send an email to Brad about moving the meeting"
      ).requiresApproval
    ).toBe(true);
  });

  it("requires confirmation before creating an automation", () => {
    const decision = getApprovalDecision(
      "automation_create",
      {
        name: "Morning brief",
        prompt: "Summarize important emails and list my calendar.",
        schedule: { frequency: "daily", time: "08:00" },
        timezone: "America/New_York"
      },
      "every morning at 8 summarize my email and calendar"
    );

    expect(decision.requiresApproval).toBe(true);
    expect(decision.confirmationKeyword).toBe("CONFIRM");
    expect(decision.confirmationMessage).toContain('Create automation "Morning brief"?');
    expect(decision.confirmationMessage).toContain("Every day at 8:00 AM America/New_York");
  });

  it("requires confirmation for selector-based automation updates and deletes", () => {
    const updateDecision = getApprovalDecision(
      "automation_update",
      {
        selector: "Creepy",
        replaceText: { from: "Creepy", to: "Kriti" }
      },
      "edit it to Kriti not Creepy"
    );
    expect(updateDecision.requiresApproval).toBe(true);
    expect(updateDecision.confirmationMessage).toContain('Update automation matching "Creepy"?');

    const selectorDeleteDecision = getApprovalDecision(
      "automation_delete",
      { selector: "daily digest" },
      "delete the daily digest automation"
    );
    expect(selectorDeleteDecision.requiresApproval).toBe(true);
    expect(selectorDeleteDecision.confirmationMessage).toContain(
      'Delete automation matching "daily digest"?'
    );

    expect(
      getApprovalDecision("automation_delete", { number: 1 }, "delete automation 1")
        .requiresApproval
    ).toBe(false);
  });

  it("allows calendar writes without extra approval", () => {
    expect(
      userClearlyRequestedCalendarWrite("Add drive down to UVA from 1-3:30 on my calendar tomorrow")
    ).toBe(true);
    expect(
      getApprovalDecision(
        "calendar_create_event",
        { title: "Drive down to UVA", start: "2026-04-21T17:00:00.000Z", end: "2026-04-21T19:30:00.000Z" },
        "Add drive down to UVA from 1-3:30 on my calendar tomorrow"
      ).requiresApproval
    ).toBe(false);
    expect(
      getApprovalDecision(
        "calendar_create_event",
        { title: "Drive down to UVA", start: "2026-04-21T17:00:00.000Z", end: "2026-04-21T19:30:00.000Z" },
        "Move that to April 21st same time"
      ).requiresApproval
    ).toBe(false);
    expect(
      getApprovalDecision(
        "calendar_create_event",
        {
          title: "Lunch",
          start: "2026-04-24T17:00:00.000Z",
          end: "2026-04-24T18:00:00.000Z",
          attendees: ["alex@example.com"]
        },
        "schedule lunch with Alex"
      ).requiresApproval
    ).toBe(false);
    expect(
      getApprovalDecision(
        "calendar_delete_event",
        { eventId: "event_123", calendarId: "primary" },
        "Delete that and the one on Apr 22"
      ).requiresApproval
    ).toBe(false);
    expect(
      getApprovalDecision(
        "drive_delete_file",
        { fileId: "file_123" },
        "delete the outdated doc"
      ).requiresApproval
    ).toBe(false);
  });

  it("allows Google Doc writes without extra approval", () => {
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
    ).toBe(false);
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

  it("cancels older pending actions of the same type before creating a new pending action", async () => {
    const prisma = {
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async ({ data }) => ({ id: "pending_new", ...data }))
      }
    };

    await createPendingAction(prisma as any, {
      userId: "user_1",
      conversationId: "conversation_1",
      actionType: "automation_create",
      payload: {
        toolName: "automation_create",
        input: {
          name: "Daily reminder to track points with Kriti",
          prompt: "Track points with Kriti.",
          schedule: { frequency: "daily", time: "23:00" },
          timezone: "America/New_York"
        },
        confirmationKeyword: "CONFIRM"
      }
    });

    expect(prisma.pendingAction.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        conversationId: "conversation_1",
        actionType: "automation_create",
        status: PendingActionStatus.PENDING
      },
      data: { status: PendingActionStatus.CANCELLED }
    });
    expect(prisma.pendingAction.create).toHaveBeenCalledOnce();
  });

  it("formats pending draft context for the prompt", () => {
    const context = buildPendingActionContext({
      payload: {
        toolName: "gmail_send_draft",
        input: { draftId: "draft_123" },
        confirmationKeyword: "CONFIRM",
        context: {
          to: "brad@example.com",
          subject: "Meeting tomorrow",
          body: "Let's meet at 9:00 AM."
        }
      }
    } as any);

    expect(context).toContain("Pending action: email draft available.");
    expect(context).toContain("To: brad@example.com");
    expect(context).toContain("Subject: Meeting tomorrow");
    expect(context).toContain("Let's meet at 9:00 AM.");
    expect(context).toContain("Draft ID: draft_123");
  });
});
