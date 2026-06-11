import { AutomationStatus, PendingActionStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../src/modules/agent/toolExecutor";

describe("tool executor automations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T11:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stages automation creation behind one confirmation", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async () => ({ id: "pending_1" }))
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn() } as any,
      { getAccessTokenForUser: vi.fn() } as any
    );

    const result = await executor.executeToolCall(
      "automation_create",
      {
        name: "Morning brief",
        prompt: "Summarize important emails and list my calendar.",
        schedule: { frequency: "daily", time: "08:00" }
      },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "every morning at 8 summarize my email and calendar"
      }
    );

    expect(result.approvalRequired).toBe(true);
    expect(result.userMessage).toContain('Create automation "Morning brief"?');
    expect(prisma.pendingAction.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        conversationId: "conversation_1",
        actionType: "automation_create",
        status: PendingActionStatus.PENDING
      },
      data: { status: PendingActionStatus.CANCELLED }
    });
    expect(prisma.pendingAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "automation_create",
          payload: expect.objectContaining({
            toolName: "automation_create",
            confirmationKeyword: "CONFIRM",
            input: expect.objectContaining({
              timezone: "America/New_York"
            })
          })
        })
      })
    );
  });

  it("creates an automation after confirmation", async () => {
    const automationCreate = vi.fn(async ({ data }) => ({
      id: "automation_1",
      ...data,
      status: AutomationStatus.ACTIVE,
      lastRunAt: null,
      lockedAt: null,
      lockedBy: null,
      lockExpiresAt: null,
      createdAt: new Date("2026-04-24T11:00:00.000Z"),
      updatedAt: new Date("2026-04-24T11:00:00.000Z")
    }));
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      automation: {
        create: automationCreate
      },
      pendingAction: {
        update: vi.fn(async () => undefined)
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn() } as any,
      { getAccessTokenForUser: vi.fn() } as any
    );

    const result = await executor.executePendingAction(
      {
        id: "pending_1",
        payload: {
          toolName: "automation_create",
          input: {
            name: "Morning brief",
            prompt: "Summarize important emails and list my calendar.",
            schedule: { frequency: "daily", time: "08:00" },
            timezone: "America/New_York"
          },
          confirmationKeyword: "CONFIRM"
        }
      } as any,
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "yes"
      },
      "CONFIRM"
    );

    expect(result.ok).toBe(true);
    expect(result.userMessage).toContain("Created automation: Morning brief.");
    expect(result.userMessage).toContain("Next run: Fri, Apr 24, 2026 8:00 AM");
    expect(automationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user_1",
          conversationId: "conversation_1",
          scheduleLabel: "Every day at 8:00 AM America/New_York",
          nextRunAt: new Date("2026-04-24T12:00:00.000Z")
        })
      })
    );
    expect(prisma.pendingAction.update).toHaveBeenLastCalledWith({
      where: { id: "pending_1" },
      data: { status: PendingActionStatus.EXECUTED }
    });
  });

  it("updates an existing automation by replacing misheard text", async () => {
    const existingAutomation = {
      id: "automation_1",
      userId: "user_1",
      conversationId: "conversation_1",
      channel: "WHATSAPP",
      name: "Daily reminder to track points with Creepy",
      prompt:
        "Send a WhatsApp reminder every day at 11:00 PM to track points with Creepy.",
      schedule: { frequency: "daily", time: "23:00" },
      scheduleLabel: "Every day at 11:00 PM America/New_York",
      timezone: "America/New_York",
      status: AutomationStatus.ACTIVE,
      nextRunAt: new Date("2026-04-25T03:00:00.000Z"),
      lastRunAt: null,
      lockedAt: null,
      lockedBy: null,
      lockExpiresAt: null,
      createdAt: new Date("2026-04-24T11:00:00.000Z"),
      updatedAt: new Date("2026-04-24T11:00:00.000Z")
    };
    const automationUpdate = vi.fn(async ({ data }) => ({
      ...existingAutomation,
      ...data,
      updatedAt: new Date("2026-04-24T11:01:00.000Z")
    }));
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      automation: {
        findMany: vi.fn(async () => [existingAutomation]),
        update: automationUpdate
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn() } as any,
      { getAccessTokenForUser: vi.fn() } as any
    );

    const result = await executor.executeToolCall(
      "automation_update",
      {
        selector: "Creepy",
        replaceText: { from: "Creepy", to: "Kriti" }
      },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "No can u edit it to with Kriti not creepy"
      },
      { force: true }
    );

    expect(result.ok).toBe(true);
    expect(result.userMessage).toContain("Updated automation: Daily reminder to track points with Kriti.");
    expect(automationUpdate).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: {
        name: "Daily reminder to track points with Kriti",
        prompt: "Send a WhatsApp reminder every day at 11:00 PM to track points with Kriti."
      }
    });
  });

  it("stages selector-based automation deletion behind confirmation", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async () => ({ id: "pending_delete" }))
      },
      automation: {
        update: vi.fn()
      }
    } as any;

    const executor = new ToolExecutor(
      prisma,
      { getOAuthClientForUser: vi.fn() } as any,
      { getAccessTokenForUser: vi.fn() } as any
    );

    const result = await executor.executeToolCall(
      "automation_delete",
      { selector: "Morning email, calendar, and Asana digest" },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "delete the morning digest automation"
      }
    );

    expect(result.approvalRequired).toBe(true);
    expect(result.userMessage).toContain(
      'Delete automation matching "Morning email, calendar, and Asana digest"?'
    );
    expect(prisma.automation.update).not.toHaveBeenCalled();
  });
});
