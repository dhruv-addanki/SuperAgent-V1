import { AutomationRunStatus, AutomationStatus, Channel, MessageRole } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const runResponseLoopMock = vi.fn();

vi.mock("../src/modules/agent/responseLoop", () => ({
  runResponseLoop: (...args: any[]) => runResponseLoopMock(...args)
}));

import { AutomationScheduler } from "../src/modules/automation/automationScheduler";
import { ToolExecutor } from "../src/modules/agent/toolExecutor";

describe("automation scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    runResponseLoopMock.mockReset();
  });

  it("claims a due automation, sends the WhatsApp digest, and records success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Morning digest:\n\nHere is your morning brief.",
      toolRounds: 1
    });

    const user = {
      id: "user_1",
      whatsappPhone: "+15555550100",
      googleEmail: "dhruv@example.com",
      timezone: "America/New_York",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z")
    };
    const conversation = {
      id: "conversation_1",
      userId: "user_1",
      channel: Channel.WHATSAPP,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z")
    };
    const automation = {
      id: "automation_1",
      userId: "user_1",
      conversationId: "conversation_1",
      channel: Channel.WHATSAPP,
      name: "Morning brief",
      prompt: "Summarize important emails and list calendar events.",
      schedule: { frequency: "daily", time: "08:00" },
      scheduleLabel: "Every day at 8:00 AM America/New_York",
      timezone: "America/New_York",
      status: AutomationStatus.ACTIVE,
      nextRunAt: new Date("2026-04-24T12:00:00.000Z"),
      lastRunAt: null,
      lockedAt: null,
      lockedBy: null,
      lockExpiresAt: null,
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      user,
      conversation
    };

    const prisma = {
      automation: {
        findMany: vi.fn(async () => [automation]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => automation),
        update: vi.fn(async () => undefined)
      },
      automationRun: {
        create: vi.fn(async () => ({
          id: "run_1",
          automationId: "automation_1"
        })),
        update: vi.fn(async () => undefined)
      },
      memoryEntry: {
        findMany: vi.fn(async () => [])
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      notionAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      message: {
        create: vi.fn(async () => undefined),
        findFirst: vi.fn(async () => null)
      },
      conversation: {
        update: vi.fn(async () => undefined)
      },
      auditLog: {
        create: vi.fn(async () => undefined)
      },
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations))
    } as any;
    const whatsappService = {
      sendTextMessage: vi.fn(async () => ({ messageId: "wamid.digest" })),
      sendTemplateMessage: vi.fn(async () => ({ messageId: "wamid.template" }))
    } as any;

    const scheduler = new AutomationScheduler(
      prisma,
      { createResponse: vi.fn() } as any,
      whatsappService,
      {
        workerId: "worker_1",
        forceTextDelivery: true
      }
    );

    const count = await scheduler.runDueOnce(new Date("2026-04-24T12:00:00.000Z"));

    expect(count).toBe(1);
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(
      runResponseLoopMock.mock.calls[0][0].tools.some(
        (tool: any) => tool.name === "automation_list"
      )
    ).toBe(false);
    expect(runResponseLoopMock.mock.calls[0][0]).toMatchObject({
      continueAfterToolMessages: true
    });
    expect(runResponseLoopMock.mock.calls[0][0].instructions).toContain("use asana_list_my_tasks");
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({ ok: true, data: [] });
    await runResponseLoopMock.mock.calls[0][0].executeTool("asana_list_project_tasks", {
      projectGid: "My Tasks",
      limit: 10
    });
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.objectContaining({
        completed: false,
        limit: 10,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({
        latestUserMessage: "Summarize important emails and list calendar events."
      }),
      { force: true }
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Morning brief\n\nHere is your morning brief."
    );
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conversation_1",
          role: MessageRole.ASSISTANT,
          content: "Morning brief\n\nHere is your morning brief."
        })
      })
    );
    expect(prisma.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run_1" },
        data: expect.objectContaining({
          status: AutomationRunStatus.SUCCESS,
          outputText: "Morning brief\n\nHere is your morning brief."
        })
      })
    );
    expect(prisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "automation_1" },
        data: expect.objectContaining({
          nextRunAt: new Date("2026-04-25T12:00:00.000Z"),
          lockedAt: null,
          lockedBy: null,
          lockExpiresAt: null
        })
      })
    );
  });
});
