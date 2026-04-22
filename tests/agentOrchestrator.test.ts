import { describe, expect, it, vi } from "vitest";

const runResponseLoopMock = vi.fn();

vi.mock("../src/modules/agent/responseLoop", () => ({
  runResponseLoop: (...args: any[]) => runResponseLoopMock(...args)
}));

import { AgentOrchestrator } from "../src/modules/agent/agentOrchestrator";

describe("agent orchestrator", () => {
  it("does not require Google to be connected before handling Asana requests", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Asana tasks ready",
      toolRounds: 0
    });

    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          timezone: "America/New_York"
        }))
      },
      conversation: {
        findFirst: vi.fn(async () => ({
          id: "conversation_1",
          userId: "user_1"
        }))
      },
      message: {
        create: vi.fn(async () => undefined),
        findMany: vi.fn(async () => [])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [])
      },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null)
      }
    } as any;

    const whatsappService = {
      sendTextMessage: vi.fn(async () => undefined),
      sendTypingIndicator: vi.fn(async () => undefined)
    } as any;

    const orchestrator = new AgentOrchestrator(
      prisma,
      { createResponse: vi.fn() } as any,
      whatsappService
    );

    await orchestrator.processInboundWhatsAppText({
      from: "+15555550100",
      text: "Show my Asana tasks"
    });

    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Asana tasks ready"
    );
  });
});
