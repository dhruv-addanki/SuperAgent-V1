import { AutomationStatus, MessageRole, PendingActionStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const runResponseLoopMock = vi.fn();

vi.mock("../src/modules/agent/responseLoop", () => ({
  extractOutputText: (response: any) => response.output_text?.trim() ?? "",
  runResponseLoop: (...args: any[]) => runResponseLoopMock(...args)
}));

import { AgentOrchestrator } from "../src/modules/agent/agentOrchestrator";
import { ToolExecutor } from "../src/modules/agent/toolExecutor";
import { ObsidianContextGraphService } from "../src/modules/contextGraph/obsidianContextGraphService";
import { UserFacingError } from "../src/lib/errors";

describe("agent orchestrator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runResponseLoopMock.mockReset();
    vi.useRealTimers();
  });

  it("does not require Google to be connected before handling Asana requests", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [{ gid: "task_1", name: "Asana task", completed: false }]
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
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.objectContaining({
        completed: false,
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({
        latestUserMessage: "Show my Asana tasks"
      })
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Asana task")
    );
  });

  it("normalizes assistant replies before persisting and sending", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Done — booked.",
      toolRounds: 0
    });

    const messageCreate = vi.fn(async () => undefined);
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
        create: messageCreate,
        findMany: vi.fn(async () => [
          { role: MessageRole.USER, content: "previous message" },
          { role: MessageRole.ASSISTANT, content: "previous reply" }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "reply normally"
    });

    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith("+15555550100", "Done, booked.");
    expect(messageCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: "Done, booked."
        })
      })
    );
  });

  it("acknowledges response style configuration without calling the model", async () => {
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
        create: vi.fn(async () => undefined)
      },
      memoryEntry: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 }))
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
      text: "from now on be casual and dont use - in text casually"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Got it. I'll keep replies casual, no casual dash separators."
    );
  });

  it("retries missing automation digest sections without treating My Tasks as a project", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockImplementation(async (toolName: string) => {
        if (toolName === "calendar_list_events") {
          return {
            ok: false,
            error: "GOOGLE_API_ERROR",
            userMessage: "I couldn't reach Google Calendar right now."
          };
        }
        if (toolName === "asana_list_my_tasks") {
          return {
            ok: true,
            data: [
              {
                gid: "task_1",
                name: "Review launch plan",
                completed: false
              }
            ]
          };
        }
        return { ok: false, error: "unexpected tool" };
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
        findMany: vi.fn(async () => [
          { role: MessageRole.USER, content: "yes retry the missing parts" },
          {
            role: MessageRole.ASSISTANT,
            content:
              "Morning email, calendar, and Asana digest\n\nMorning digest:\n\nCalendar: I couldn't reach Google Calendar right now.\n\nAsana: I couldn't pull your My Tasks in this run because the saved automation call hit a project resolution issue."
          }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "yes retry the missing parts"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "calendar_list_events",
      expect.objectContaining({ maxResults: 50 }),
      expect.objectContaining({ latestUserMessage: "yes retry the missing parts" })
    );
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.not.objectContaining({ projectGid: expect.anything() }),
      expect.objectContaining({ latestUserMessage: "yes retry the missing parts" })
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Review launch plan")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("I couldn't reach Google Calendar right now.")
    );
  });

  it("retries Gmail and Calendar without relisting Asana when Asana was only context", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockImplementation(async (toolName: string) => {
        if (toolName === "gmail_search_threads") {
          return {
            ok: true,
            data: [
              {
                threadId: "thread_1",
                subject: "Launch update",
                from: "pm@example.com",
                snippet: "Today looks good"
              }
            ]
          };
        }
        if (toolName === "calendar_list_events") {
          return {
            ok: false,
            error: "GOOGLE_API_ERROR",
            userMessage: "I couldn't reach Google Calendar right now."
          };
        }
        return { ok: false, error: "unexpected tool" };
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
        findMany: vi.fn(async () => [
          { role: MessageRole.USER, content: "yes retry the missing parts" },
          {
            role: MessageRole.ASSISTANT,
            content:
              "Morning email, calendar, and Asana digest\n\nAt a glance: Gmail and calendar didn’t load, so this is an Asana-led snapshot. No same-day due tasks shown, but you’ve got a backlog of overdue items.\n\nSchedule: Calendar data was unavailable for this run."
          }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "yes retry the missing parts"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "gmail_search_threads",
      expect.objectContaining({
        query: "in:inbox newer_than:1d",
        maxResults: 10
      }),
      expect.objectContaining({ latestUserMessage: "yes retry the missing parts" })
    );
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "calendar_list_events",
      expect.objectContaining({ maxResults: 50 }),
      expect.objectContaining({ latestUserMessage: "yes retry the missing parts" })
    );
    expect(executeToolCallSpy).not.toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.anything(),
      expect.anything()
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Launch update")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("I couldn't reach Google Calendar right now.")
    );
  });

  it("runs a one-time automation digest with fixed Gmail, Calendar, and My Tasks reads", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockImplementation(async (toolName: string) => {
        if (toolName === "gmail_search_threads") {
          return {
            ok: true,
            data: [
              {
                threadId: "thread_1",
                subject: "SF86 correction",
                from: "security@example.com",
                snippet: "Please resubmit"
              }
            ]
          };
        }
        if (toolName === "calendar_list_events") {
          return {
            ok: true,
            data: []
          };
        }
        if (toolName === "asana_list_my_tasks") {
          return {
            ok: true,
            data: [
              {
                gid: "task_1",
                name: "Systems Class Ex1 Due",
                completed: false,
                dueOn: "2026-04-20"
              }
            ]
          };
        }
        return { ok: false, error: "unexpected tool" };
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
        findMany: vi.fn(async () => [
          { role: MessageRole.USER, content: "Do it manually yes" },
          {
            role: MessageRole.ASSISTANT,
            content:
              "I can do the same checks manually right now, but I can’t trigger the scheduled automation itself on demand.\n\nWant me to run the one-time digest now?"
          }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "Do it manually yes"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "gmail_search_threads",
      expect.objectContaining({
        query: "in:inbox newer_than:1d",
        maxResults: 10
      }),
      expect.objectContaining({ latestUserMessage: "Do it manually yes" }),
      { force: true }
    );
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "calendar_list_events",
      expect.objectContaining({ maxResults: 50 }),
      expect.objectContaining({ latestUserMessage: "Do it manually yes" }),
      { force: true }
    );
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.not.objectContaining({ projectGid: expect.anything() }),
      expect.objectContaining({ latestUserMessage: "Do it manually yes" }),
      { force: true }
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Morning email, calendar, and Asana digest")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("SF86 correction")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Systems Class Ex1 Due")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Action items:")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Further prompts:")
    );
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Watchouts:")
    );
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("I couldn't identify that Asana project")
    );
  });

  it("returns setup status for explicit setup requests without calling the model", async () => {
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: null,
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
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) },
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
      text: "setup"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Setup status:")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("/auth/google/start?phone=%2B15555550100")
    );
  });

  it("returns setup status for first-time greetings with no integrations", async () => {
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: null,
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
        findMany: vi.fn(async () => [{ role: "USER", content: "hi" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) },
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
      text: "hi"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Google powers Calendar, Gmail, Drive, and Docs.")
    );
  });

  it("returns a Notion connect link immediately for clear missing Notion requests", async () => {
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: "dhruv@gmail.com",
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
        findMany: vi.fn(async () => [{ role: "USER", content: "check what i have in notion" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [])
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) },
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
      text: "check what i have in notion"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringMatching(/^Connect Notion first: .*\/auth\/notion\/start\?phone=%2B15555550100$/)
    );
  });

  it("returns a Notion reconnect link when asked even if Notion is connected", async () => {
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: "dhruv@gmail.com",
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
        findMany: vi.fn(async () => [{ role: "USER", content: "send notion link" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [])
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      notionAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
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
      text: "send notion link"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("/auth/notion/start?phone=%2B15555550100")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("select more pages")
    );
  });

  it("returns an Asana connect link immediately for clear missing Asana requests", async () => {
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: "dhruv@gmail.com",
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
        findMany: vi.fn(async () => [{ role: "USER", content: "show my Asana tasks" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [])
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
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
      text: "show my Asana tasks"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringMatching(/^Connect Asana first: .*\/auth\/asana\/start\?phone=%2B15555550100$/)
    );
  });

  it("returns a Google connect link immediately for clear missing Google app requests", async () => {
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: null,
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
        findMany: vi.fn(async () => [{ role: "USER", content: "read my Gmail" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [])
      },
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      notionAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
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
      text: "read my Gmail"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringMatching(/^Connect Google first: .*\/auth\/google\/start\?phone=%2B15555550100$/)
    );
  });

  it("returns the single missing integration link even in compound requests", async () => {
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: "dhruv@gmail.com",
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
        findMany: vi.fn(async () => [
          { role: "USER", content: "check my calendar and show my Asana tasks" }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [])
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
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
      text: "check my calendar and show my Asana tasks"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringMatching(/^Connect Asana first: .*\/auth\/asana\/start\?phone=%2B15555550100$/)
    );
  });

  it("still runs substantive first-time requests and appends a setup hint", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "I can help with that.",
      toolRounds: 0
    });
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: null,
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
        findMany: vi.fn(async () => [{ role: "USER", content: "what can you do" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [])
      },
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) },
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
      text: "what can you do"
    });

    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "I can help with that.\n\nFor full setup, reply setup to connect Google, Asana, Notion."
    );
  });

  it("routes recurring multi-app requests through the model with automation instructions", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: 'Create automation "Morning brief"? Reply yes to create it, or cancel.',
      toolRounds: 0,
      stoppedForApproval: true
    });
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: "dhruv@example.com",
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
        findMany: vi.fn(async () => [
          {
            role: "USER",
            content:
              "every morning at 8:00AM summarize my important emails, list my calendar, and make an Asana plan"
          }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      notionAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
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
      text: "every morning at 8:00AM summarize my important emails, list my calendar, and make an Asana plan"
    });

    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(runResponseLoopMock.mock.calls[0][0].instructions).toContain("use automation_create");
    expect(runResponseLoopMock.mock.calls[0][0].instructions).toContain(
      "Active app/workflow: multi"
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      'Create automation "Morning brief"? Reply yes to create it, or cancel.'
    );
  });

  it("replaces a pending automation create payload when the user corrects a misheard name", async () => {
    const pendingActionCreate = vi.fn(async ({ data }) => ({ id: "pending_kriti", ...data }));
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
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) },
      auditLog: { create: vi.fn(async () => undefined) },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findFirst: vi.fn(async () => ({
          id: "pending_creepy",
          userId: "user_1",
          conversationId: "conversation_1",
          actionType: "automation_create",
          status: PendingActionStatus.PENDING,
          expiresAt: new Date("2026-06-10T18:00:00.000Z"),
          createdAt: new Date("2026-06-10T17:06:17.000Z"),
          payload: {
            toolName: "automation_create",
            input: {
              name: "Daily reminder to track points with Creepy",
              prompt:
                "Send a WhatsApp reminder every day at 11:00 PM to track points with Creepy.",
              schedule: { frequency: "daily", time: "23:00" },
              timezone: "America/New_York"
            },
            confirmationKeyword: "CONFIRM"
          }
        })),
        create: pendingActionCreate
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
      text: "No with Kriti not creepy"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    const sent = whatsappService.sendTextMessage.mock.calls[0][1] as string;
    expect(sent).toContain('Create automation "Daily reminder to track points with Kriti"?');
    expect(sent).toContain("track points with Kriti");
    expect(sent).not.toContain("Creepy");
    expect(pendingActionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "automation_create",
          payload: expect.objectContaining({
            input: expect.objectContaining({
              name: "Daily reminder to track points with Kriti",
              prompt:
                "Send a WhatsApp reminder every day at 11:00 PM to track points with Kriti."
            })
          })
        })
      })
    );
  });

  it("updates an existing misheard automation instead of deleting another automation", async () => {
    const existingAutomation = {
      id: "automation_creepy",
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
      nextRunAt: new Date("2026-06-11T03:00:00.000Z"),
      lastRunAt: null,
      lockedAt: null,
      lockedBy: null,
      lockExpiresAt: null,
      createdAt: new Date("2026-06-10T17:09:27.000Z"),
      updatedAt: new Date("2026-06-10T17:09:27.000Z")
    };
    const automationUpdate = vi.fn(async ({ data }) => ({
      ...existingAutomation,
      ...data,
      updatedAt: new Date("2026-06-10T17:09:54.000Z")
    }));
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
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) },
      auditLog: { create: vi.fn(async () => undefined) },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null)
      },
      automation: {
        findMany: vi.fn(async () => [existingAutomation]),
        update: automationUpdate
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
      text: "No can u edit it to with Kriti not creepy"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(automationUpdate).toHaveBeenCalledWith({
      where: { id: "automation_creepy" },
      data: {
        name: "Daily reminder to track points with Kriti",
        prompt: "Send a WhatsApp reminder every day at 11:00 PM to track points with Kriti."
      }
    });
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Updated automation: Daily reminder to track points with Kriti.")
    );
  });

  it("uses chat history instead of dead-ending when yes has no pending backend action", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "I deleted the current doc.",
      toolRounds: 1
    });

    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: "dhruv@example.com",
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
        findMany: vi.fn(async () => [
          {
            role: "USER",
            content: "yes"
          },
          {
            role: "ASSISTANT",
            content: "Do you want me to delete the current Google Doc?"
          }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [
          {
            key: "recent_google_doc",
            value: {
              documentId: "doc_123",
              title: "Scratch Doc"
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      notionAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
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
      text: "yes"
    });

    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(runResponseLoopMock.mock.calls[0][0].input).toEqual([
      {
        role: "assistant",
        content: "Do you want me to delete the current Google Doc?"
      },
      {
        role: "user",
        content: "yes"
      }
    ]);
    expect(runResponseLoopMock.mock.calls[0][0].instructions).toContain(
      "Google Doc: Scratch Doc (documentId: doc_123)"
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "I deleted the current doc."
    );
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("pending to confirm")
    );
  });

  it("returns a short Google connect link when a calendar shortcut needs auth", async () => {
    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: null,
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
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null)
      },
      auditLog: { create: vi.fn(async () => undefined) }
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
      text: "Check my calendar"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringMatching(/^Connect Google first: .*\/auth\/google\/start\?phone=%2B15555550100$/)
    );
  });

  it("builds structured conversation context for follow-up prompt assembly", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Updated the doc",
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
        findMany: vi.fn(async () => [
          {
            key: "recent_google_doc",
            value: {
              documentId: "doc_123",
              title: "Strategy Notes",
              url: "https://docs.google.com/document/d/doc_123/edit"
            }
          },
          {
            key: "recent_asana_tasks",
            value: [{ taskGid: "task_1", name: "Old task" }]
          }
        ])
      },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null)
      }
    } as any;

    const orchestrator = new AgentOrchestrator(
      prisma,
      { createResponse: vi.fn() } as any,
      {
        sendTextMessage: vi.fn(async () => undefined),
        sendTypingIndicator: vi.fn(async () => undefined)
      } as any
    );

    await orchestrator.processInboundWhatsAppText({
      from: "+15555550100",
      text: "append this to the same doc"
    });

    const instructions = runResponseLoopMock.mock.calls[0][0].instructions;
    expect(instructions).toContain("Active app/workflow: docs");
    expect(instructions).toContain("Google Doc: Strategy Notes (documentId: doc_123)");
    expect(instructions).not.toContain("Old task");
  });

  it("deletes the current Google Doc directly when recent doc context is clear", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: {
          fileId: "doc_123",
          name: "Scratch Doc"
        },
        userMessage: "Moved to trash: Scratch Doc"
      });

    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: "dhruv@example.com",
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
        findMany: vi.fn(async () => [
          {
            key: "recent_google_doc",
            value: {
              documentId: "doc_123",
              title: "Scratch Doc"
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      notionAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
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
      text: "delete the current doc"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "drive_delete_file",
      { fileId: "doc_123" },
      expect.objectContaining({
        latestUserMessage: "delete the current doc"
      })
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Moved to trash: Scratch Doc"
    );
  });

  it("short-circuits generic Asana due-today requests before the response loop", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            gid: "task_1",
            name: "Test task 1",
            completed: false
          }
        ]
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
      text: "show my asana tasks due today"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.objectContaining({
        dueOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        completed: false,
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({
        latestUserMessage: "show my asana tasks due today"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Here are the open Asana tasks due today:\n\n1. Test task 1"
    );
  });

  it("routes overdue My Tasks date ranges through deterministic Asana reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T16:00:00.000Z"));
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: Array.from({ length: 25 }, (_, index) => ({
          gid: `task_${index + 1}`,
          name: `Old task ${index + 1}`,
          completed: false,
          dueOn: "2026-02-14"
        }))
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
      text: "list all open Asana My Tasks due before today, sorted oldest first, limit 50"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.objectContaining({
        completed: false,
        dueBefore: "2026-05-01",
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({
        latestUserMessage:
          "list all open Asana My Tasks due before today, sorted oldest first, limit 50"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("25. Old task 25")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.not.stringContaining("Showing first")
    );
  });

  it("routes project-scoped overdue Asana reads with projectName resolution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T16:00:00.000Z"));
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            gid: "task_1",
            name: "Scanis old task",
            completed: false,
            dueOn: "2026-02-16",
            projects: [{ gid: "project_1", name: "Scanis-OLD" }]
          }
        ]
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
      text: "show open tasks in Scanis-OLD due before today"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_project_tasks",
      expect.objectContaining({
        projectName: "Scanis-OLD",
        completed: false,
        dueBefore: "2026-05-01",
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({
        latestUserMessage: "show open tasks in Scanis-OLD due before today"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Scanis old task")
    );
  });

  it("asks which project after a vague yes to an offered project choice", async () => {
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");
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
        findMany: vi.fn(async () => [
          {
            role: MessageRole.ASSISTANT,
            content:
              "If you want, I can check a specific project instead, like Scanis-OLD or School."
          }
        ])
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
      text: "yes do that"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Which project should I check: Scanis-OLD or School?"
    );
  });

  it("updates an Asana task due date deterministically despite punctuation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T04:20:00.000Z"));
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: {
          gid: "task_1",
          name: "check with parents",
          completed: false,
          dueOn: "2026-05-06"
        }
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
      text: "Move my check with parents... task to be due today"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_update_task",
      {
        taskName: "check with parents",
        dueOn: "2026-05-06"
      },
      expect.objectContaining({
        latestUserMessage: "Move my check with parents... task to be due today"
      }),
      { force: true }
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Updated: check with parents\nDue: 2026-05-06"
    );
  });

  it("preserves Asana task-not-found diagnostics for due-date updates", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: false,
        error: "ASANA_NOT_FOUND",
        userMessage:
          'I could not find an Asana task named "check with parents". Try listing matching tasks first.'
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
      text: "Move check with parents asana task due date to tmr"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_update_task",
      expect.objectContaining({
        taskName: "check with parents"
      }),
      expect.anything(),
      { force: true }
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      'I could not find an Asana task named "check with parents". Try listing matching tasks first.'
    );
  });

  it("asks for the missing due date on incomplete Asana update commands", async () => {
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");
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
      text: "Move the check case study task from"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      'What due date should I move "check case study" to?'
    );
  });

  it("routes yes after an overdue offer to open overdue My Tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T16:00:00.000Z"));
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            gid: "task_1",
            name: "no due project test",
            completed: false,
            dueOn: "2026-05-03"
          }
        ]
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
        findMany: vi.fn(async () => [
          {
            role: MessageRole.ASSISTANT,
            content:
              "No Asana tasks were due yesterday.\n\nIf you want, I can show overdue tasks instead."
          }
        ])
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
      text: "Yes"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      {
        completed: false,
        dueBefore: "2026-05-05",
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      },
      expect.objectContaining({
        latestUserMessage: "Yes"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("no due project test")
    );
  });

  it("routes completed Asana tasks on an exact due date through deterministic reads", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            gid: "task_1",
            name: "Completed old task",
            completed: true,
            dueOn: "2026-02-14"
          }
        ]
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
      text: "show completed Asana tasks due on 2026-02-14"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.objectContaining({
        completed: true,
        dueOn: "2026-02-14",
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({
        latestUserMessage: "show completed Asana tasks due on 2026-02-14"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Here are the completed Asana tasks due on 2026-02-14:")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Completed old task")
    );
  });

  it("transcribes voice messages before routing them through normal shortcuts", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            gid: "task_1",
            name: "Voice task",
            completed: false
          }
        ]
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
    const whatsappMediaService = {
      downloadAudio: vi.fn(async () => ({
        buffer: Buffer.from([1, 2, 3]),
        filename: "audio-id.ogg",
        mediaId: "audio-id",
        mimeType: "audio/ogg",
        sha256: "hash"
      })),
      downloadImage: vi.fn()
    };
    const audioTranscriptionService = {
      transcribe: vi.fn(async () => ({
        text: "show my asana tasks due today",
        model: "gpt-4o-mini-transcribe"
      }))
    };

    const orchestrator = new AgentOrchestrator(
      prisma,
      { createResponse: vi.fn() } as any,
      whatsappService,
      {
        whatsappMediaService,
        audioTranscriptionService
      }
    );

    await orchestrator.processInboundWhatsAppMessage({
      kind: "audio",
      from: "+15555550100",
      messageId: "wamid.audio",
      mediaId: "audio-id",
      mimeType: "audio/ogg; codecs=opus",
      sha256: "hash",
      isVoice: true,
      raw: { type: "audio" }
    });

    expect(whatsappMediaService.downloadAudio).toHaveBeenCalledWith({
      mediaId: "audio-id",
      mimeType: "audio/ogg; codecs=opus",
      sha256: "hash"
    });
    expect(audioTranscriptionService.transcribe).toHaveBeenCalledWith({
      buffer: Buffer.from([1, 2, 3]),
      filename: "audio-id.ogg",
      mimeType: "audio/ogg"
    });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "USER",
          senderPhone: "+15555550100",
          content: "show my asana tasks due today",
          rawPayload: expect.objectContaining({
            kind: "audio",
            transcription: { model: "gpt-4o-mini-transcribe" }
          })
        })
      })
    );
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.objectContaining({
        completed: false,
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({ latestUserMessage: "show my asana tasks due today" })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Here are the open Asana tasks due today:\n\n1. Voice task"
    );
  });

  it("replies with the transcription failure without invoking the agent loop", async () => {
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
    const whatsappMediaService = {
      downloadAudio: vi.fn(async () => ({
        buffer: Buffer.from([1]),
        filename: "audio-id.ogg",
        mediaId: "audio-id",
        mimeType: "audio/ogg"
      })),
      downloadImage: vi.fn()
    };
    const audioTranscriptionService = {
      transcribe: vi.fn(async () => {
        throw new UserFacingError(
          "Audio transcript empty",
          "AUDIO_TRANSCRIPT_EMPTY",
          "I didn't catch any speech in that voice message."
        );
      })
    };

    const orchestrator = new AgentOrchestrator(
      prisma,
      { createResponse: vi.fn() } as any,
      whatsappService,
      {
        whatsappMediaService,
        audioTranscriptionService
      }
    );

    await orchestrator.processInboundWhatsAppMessage({
      kind: "audio",
      from: "+15555550100",
      messageId: "wamid.audio",
      mediaId: "audio-id",
      raw: { type: "audio" }
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "I didn't catch any speech in that voice message."
    );
  });

  it("routes image messages through the model with image input and stores text-only metadata", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "The screenshot says the invoice is due Friday.",
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
        findMany: vi.fn(async () => [{ role: "USER", content: "what does this say?" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [
          {
            key: "recent_image_context",
            value: {
              summary:
                "Visible text: invoice due Friday. Visual context: invoice screenshot. Likely user intent: extract the due date.",
              caption: "what does this say?"
            },
            updatedAt: new Date()
          }
        ]),
        upsert: vi.fn(async () => undefined)
      },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null)
      }
    } as any;

    const responsesClient = {
      createResponse: vi.fn(async () => ({
        output_text:
          "Visible text: invoice due Friday. Visual context: invoice screenshot. Likely user intent: extract the due date."
      }))
    } as any;
    const whatsappService = {
      sendTextMessage: vi.fn(async () => undefined),
      sendTypingIndicator: vi.fn(async () => undefined)
    } as any;
    const whatsappMediaService = {
      downloadAudio: vi.fn(),
      downloadImage: vi.fn(async () => ({
        buffer: Buffer.from([1, 2, 3]),
        filename: "image-id.png",
        mediaId: "image-id",
        mimeType: "image/png",
        sha256: "image-hash"
      }))
    };

    const orchestrator = new AgentOrchestrator(prisma, responsesClient, whatsappService, {
      whatsappMediaService,
      audioTranscriptionService: { transcribe: vi.fn() }
    });

    await orchestrator.processInboundWhatsAppMessage({
      kind: "image",
      from: "+15555550100",
      messageId: "wamid.image",
      mediaId: "image-id",
      mimeType: "image/png",
      sha256: "image-hash",
      caption: "what does this say?",
      raw: { type: "image" }
    });

    expect(whatsappMediaService.downloadImage).toHaveBeenCalledWith({
      mediaId: "image-id",
      mimeType: "image/png",
      sha256: "image-hash"
    });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "USER",
          senderPhone: "+15555550100",
          content: "what does this say?",
          rawPayload: expect.objectContaining({
            kind: "image",
            mediaId: "image-id",
            downloadedMimeType: "image/png",
            caption: "what does this say?"
          })
        })
      })
    );
    const persistedRawPayload = prisma.message.create.mock.calls[0][0].data.rawPayload;
    expect(JSON.stringify(persistedRawPayload)).not.toContain("data:image");
    expect(prisma.memoryEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user_1", key: "recent_image_context" } },
        create: expect.objectContaining({
          key: "recent_image_context",
          value: expect.objectContaining({
            summary: expect.stringContaining("Visible text: invoice due Friday"),
            mediaId: "image-id",
            mimeType: "image/png"
          })
        })
      })
    );
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    const modelInput = runResponseLoopMock.mock.calls[0][0].input[0];
    expect(modelInput.content).toEqual([
      {
        type: "input_text",
        text: "what does this say?"
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AQID",
        detail: "auto"
      }
    ]);
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "The screenshot says the invoice is due Friday."
    );
  });

  it("uses a default text prompt for images without captions", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "I can see a handwritten note.",
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
        findMany: vi.fn(async () => [{ role: "USER", content: "User sent an image." }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async () => undefined)
      },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null)
      }
    } as any;
    const responsesClient = {
      createResponse: vi.fn(async () => ({
        output_text: "Visible text: unclear. Visual context: handwritten note."
      }))
    } as any;
    const whatsappService = {
      sendTextMessage: vi.fn(async () => undefined),
      sendTypingIndicator: vi.fn(async () => undefined)
    } as any;
    const whatsappMediaService = {
      downloadAudio: vi.fn(),
      downloadImage: vi.fn(async () => ({
        buffer: Buffer.from([4, 5]),
        filename: "image-id.jpg",
        mediaId: "image-id",
        mimeType: "image/jpeg"
      }))
    };

    const orchestrator = new AgentOrchestrator(prisma, responsesClient, whatsappService, {
      whatsappMediaService,
      audioTranscriptionService: { transcribe: vi.fn() }
    });

    await orchestrator.processInboundWhatsAppMessage({
      kind: "image",
      from: "+15555550100",
      messageId: "wamid.image",
      mediaId: "image-id",
      raw: { type: "image" }
    });

    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: "User sent an image."
        })
      })
    );
    expect(runResponseLoopMock.mock.calls[0][0].input[0].content[0]).toEqual({
      type: "input_text",
      text: "User sent an image."
    });
  });

  it("includes recent image context for screenshot follow-ups", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "The screenshot shows a Notion page titled Launch Notes.",
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
        findMany: vi.fn(async () => [{ role: "USER", content: "what does that screenshot say?" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [
          {
            key: "recent_image_context",
            value: {
              summary:
                "Visible text: Launch Notes. Visual context: Notion page screenshot. Likely user intent: ask about the screenshot."
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "what does that screenshot say?"
    });

    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(runResponseLoopMock.mock.calls[0][0].instructions).toContain(
      "Recent image context: Visible text: Launch Notes."
    );
  });

  it("replies with image download failures without invoking the agent loop", async () => {
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
    const whatsappMediaService = {
      downloadAudio: vi.fn(),
      downloadImage: vi.fn(async () => {
        throw new UserFacingError(
          "WhatsApp image too large",
          "WHATSAPP_IMAGE_TOO_LARGE",
          "That image is too large to process. Please send a smaller image."
        );
      })
    };
    const responsesClient = { createResponse: vi.fn() } as any;
    const orchestrator = new AgentOrchestrator(prisma, responsesClient, whatsappService, {
      whatsappMediaService,
      audioTranscriptionService: { transcribe: vi.fn() }
    });

    await orchestrator.processInboundWhatsAppMessage({
      kind: "image",
      from: "+15555550100",
      messageId: "wamid.image",
      mediaId: "image-id",
      raw: { type: "image" }
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(responsesClient.createResponse).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "USER"
        })
      })
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "That image is too large to process. Please send a smaller image."
    );
  });

  it("defaults generic calendar checks to today across all calendars", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            title: "CS 3744",
            start: "2026-04-23T12:00:00.000Z",
            end: "2026-04-23T13:15:00.000Z"
          }
        ]
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
      text: "Check my calendar"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "calendar_list_events",
      expect.objectContaining({
        maxResults: 50
      }),
      expect.objectContaining({
        latestUserMessage: "Check my calendar"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Across all calendars today:")
    );
  });

  it("routes mixed stock and calendar-create requests through the response loop", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "NVDA summary and calendar event booked",
      toolRounds: 1
    });
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");

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
      text: "Why is NVDA stock up today and put it in my calendar to check it and make a trade decision at 3 today"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "NVDA summary and calendar event booked"
    );
  });

  it("routes calendar-read plus web lookup requests through the response loop", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Calendar and NVDA summary",
      toolRounds: 1
    });
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");

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
      text: "What's on my calendar today and why is NVDA up?"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Calendar and NVDA summary"
    );
  });

  it("routes Asana-read plus calendar-write requests through the response loop", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Asana tasks listed and reminder booked",
      toolRounds: 1
    });
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");

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
      text: "Show my Asana tasks due today and add a 3 PM calendar reminder"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Asana tasks listed and reminder booked"
    );
  });

  it("routes Notion-read plus calendar-write requests through the response loop", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Notion page found and reminder booked",
      toolRounds: 1
    });
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");

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
      text: "Find my Notion page about Scanis and add a 3 PM calendar reminder"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(runResponseLoopMock.mock.calls[0][0].instructions).toContain(
      "Active app/workflow: multi"
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Notion page found and reminder booked"
    );
  });

  it("routes stock follow-ups through the response loop after calendar text mentions Asana", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "NVDA market summary",
      toolRounds: 1
    });
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");

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
        findMany: vi.fn(async () => [
          {
            role: "ASSISTANT",
            content:
              "Across all calendars today:\n• All day: Systems Class Ex4 Due (Dhruv's tasks - My workspace (via Asana))"
          }
        ])
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
      text: "Why is nvda stock up today"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "NVDA market summary"
    );
  });

  it("asks for clarification before ambiguous Asana bulk-complete commands", async () => {
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");

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
        findMany: vi.fn(async () => [
          {
            role: "assistant",
            content: "Here are the open Asana tasks in Scanis:\n\n1. test 1\n2. test 2"
          }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [
          {
            key: "recent_asana_tasks",
            value: [
              { taskGid: "task_1", name: "test 1", projectName: "Scanis" },
              { taskGid: "task_2", name: "test 2", projectName: "Scanis" }
            ],
            updatedAt: new Date("2026-04-23T15:00:00.000Z")
          }
        ])
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
      text: "Mark all tasks as complete"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Do you mean 2 listed tasks in Scanis, or every incomplete Asana task I can see?"
    );
  });

  it("completes listed Asana tasks from backend memory without confirmation", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: {
          updated: [
            { gid: "task_1", name: "test 1", completed: true },
            { gid: "task_2", name: "test 2", completed: true }
          ]
        }
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
        findMany: vi.fn(async () => [
          {
            role: "assistant",
            content: "Here are the open Asana tasks:\n\n1. test 1\n2. test 2"
          }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [
          {
            key: "last_visible_asana_task_list",
            value: {
              scopeLabel: "My Tasks",
              tasks: [
                { taskGid: "task_1", name: "test 1", projectName: "Scanis" },
                { taskGid: "task_2", name: "test 2", dueOn: "2026-05-25" }
              ]
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "can you mark all those tasks listed as complete"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_bulk_update_tasks",
      {
        taskGids: ["task_1", "task_2"],
        completed: true,
        source: "recent_list",
        taskPreview: [
          {
            taskGid: "task_1",
            name: "test 1",
            projectName: "Scanis",
            dueOn: undefined,
            completed: undefined
          },
          {
            taskGid: "task_2",
            name: "test 2",
            projectName: undefined,
            dueOn: "2026-05-25",
            completed: undefined
          }
        ]
      },
      expect.objectContaining({
        latestUserMessage: "can you mark all those tasks listed as complete"
      }),
      { force: true }
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Completed 2 Asana tasks: test 1 (Scanis); test 2 (due 2026-05-25)."
    );
  });

  it("uses quoted WhatsApp Asana refs instead of stale visible-list memory", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: {
          updated: [
            { gid: "quoted_1", name: "Quoted task 1", completed: true },
            { gid: "quoted_2", name: "Quoted task 2", completed: true }
          ]
        }
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
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => ({
          role: "assistant",
          content: "Here are the open Asana tasks:\n\n1. Quoted task 1\n2. Quoted task 2",
          rawPayload: {
            whatsapp: { messageId: "wamid.quoted" },
            asanaTaskRefs: [
              { taskGid: "quoted_1", name: "Quoted task 1", index: 1 },
              { taskGid: "quoted_2", name: "Quoted task 2", index: 2 }
            ]
          },
          createdAt: new Date("2026-05-07T15:40:00.000Z")
        }))
      },
      memoryEntry: {
        findMany: vi.fn(async () => [
          {
            key: "last_visible_asana_task_list",
            value: {
              scopeLabel: "stale current memory",
              tasks: [
                { taskGid: "old_1", name: "Old task 1" },
                { taskGid: "old_2", name: "Old task 2" }
              ]
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      pendingAction: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null)
      }
    } as any;

    const whatsappService = {
      sendTextMessage: vi.fn(async () => ({ messageId: "wamid.outbound" })),
      sendTypingIndicator: vi.fn(async () => undefined)
    } as any;

    const orchestrator = new AgentOrchestrator(
      prisma,
      { createResponse: vi.fn() } as any,
      whatsappService
    );

    await orchestrator.processInboundWhatsAppText({
      from: "+15555550100",
      text: "mark all these as complete",
      replyToMessageId: "wamid.quoted"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_bulk_update_tasks",
      expect.objectContaining({
        taskGids: ["quoted_1", "quoted_2"],
        taskPreview: [
          { taskGid: "quoted_1", name: "Quoted task 1" },
          { taskGid: "quoted_2", name: "Quoted task 2" }
        ]
      }),
      expect.objectContaining({
        latestUserMessage: "mark all these as complete"
      }),
      { force: true }
    );
    expect(executeToolCallSpy).not.toHaveBeenCalledWith(
      "asana_bulk_update_tasks",
      expect.objectContaining({ taskGids: ["old_1", "old_2"] }),
      expect.anything(),
      expect.anything()
    );
    expect(prisma.message.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "ASSISTANT",
          rawPayload: expect.objectContaining({
            whatsapp: expect.objectContaining({ messageId: "wamid.outbound" })
          })
        })
      })
    );
  });

  it("blocks partial completion when pasted task lines do not all resolve", async () => {
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");
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
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => ({
          role: "assistant",
          content: "Here are the open Asana tasks:\n\n1. Gay Ass Homework\n2. Meditate",
          rawPayload: {
            whatsapp: { messageId: "wamid.quoted" },
            asanaTaskRefs: [
              {
                taskGid: "task_school",
                name: "Gay Ass Homework",
                projectName: "School",
                dueOn: "2026-05-03"
              },
              { taskGid: "task_meditate", name: "Meditate", dueOn: "2026-05-03" }
            ]
          }
        }))
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: [
        "mark these complete:",
        "Gay Ass Homework (School • due 2026-05-03)",
        "Missing task (No project • due 2026-05-03)"
      ].join("\n"),
      replyToMessageId: "wamid.quoted"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("I could not resolve every pasted Asana task")
    );
  });

  it("resolves a referenced automation digest cluster before broad date completion", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: {
          updated: [
            { gid: "content", name: "Content Planning", completed: true },
            { gid: "onboarding", name: "Continue Building Onboarding", completed: true },
            { gid: "test", name: "no due project test", completed: true }
          ]
        }
      });

    const digestMessage = {
      role: "assistant",
      content: [
        "Morning email, calendar, and Asana digest",
        "Asana:",
        "Older overdue cluster from May 3: Content Planning, Continue Building Onboarding, plus a few test items"
      ].join("\n"),
      rawPayload: {
        source: "automation_digest",
        whatsapp: { messageId: "wamid.digest" },
        asanaTaskRefs: [
          {
            taskGid: "content",
            name: "Content Planning",
            projectName: "Content",
            dueOn: "2026-05-03"
          },
          {
            taskGid: "onboarding",
            name: "Continue Building Onboarding",
            projectName: "Scanis-OLD",
            dueOn: "2026-05-03"
          },
          { taskGid: "test", name: "no due project test", dueOn: "2026-05-03" },
          { taskGid: "later", name: "text Verizon guy", dueOn: "2026-05-04" }
        ]
      },
      createdAt: new Date("2026-05-07T12:00:00.000Z")
    };

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
        findMany: vi.fn(async () => [digestMessage])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "complete all overdue cluster from may 3rd"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_bulk_update_tasks",
      expect.objectContaining({
        taskGids: ["content", "onboarding", "test"]
      }),
      expect.objectContaining({
        latestUserMessage: "complete all overdue cluster from may 3rd"
      }),
      { force: true }
    );
    expect(executeToolCallSpy).not.toHaveBeenCalledWith(
      "asana_bulk_update_tasks",
      expect.objectContaining({ taskGids: expect.arrayContaining(["later"]) }),
      expect.anything(),
      expect.anything()
    );
  });

  it("creates multiple voice-style Asana tasks instead of only the corrected first one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockImplementation(async (_toolName: string, rawInput: any) => ({
        ok: true,
        data: {
          gid: `created_${rawInput.name}`,
          name: rawInput.name,
          dueOn: rawInput.dueOn,
          assigneeName: "Dhruv Addanki",
          completed: false
        }
      }));

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
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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

    const transcript =
      "Add some tasks due today. First added a task called call Verizon guy actually change that to text Verizon guy. Another task called Finish Noval notes and post story another task called script video. Another task called. Call Rohan yeah";
    await orchestrator.processInboundWhatsAppText({
      from: "+15555550100",
      text: transcript
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledTimes(4);
    expect(executeToolCallSpy).toHaveBeenNthCalledWith(
      1,
      "asana_create_task",
      { name: "text Verizon guy", dueOn: "2026-05-04" },
      expect.objectContaining({ latestUserMessage: transcript }),
      { force: true }
    );
    expect(executeToolCallSpy).toHaveBeenNthCalledWith(
      2,
      "asana_create_task",
      { name: "Finish Noval notes and post story", dueOn: "2026-05-04" },
      expect.objectContaining({ latestUserMessage: transcript }),
      { force: true }
    );
    expect(executeToolCallSpy).toHaveBeenNthCalledWith(
      3,
      "asana_create_task",
      { name: "script video", dueOn: "2026-05-04" },
      expect.objectContaining({ latestUserMessage: transcript }),
      { force: true }
    );
    expect(executeToolCallSpy).toHaveBeenNthCalledWith(
      4,
      "asana_create_task",
      { name: "Call Rohan", dueOn: "2026-05-04" },
      expect.objectContaining({ latestUserMessage: transcript }),
      { force: true }
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      [
        "Created 4 Asana tasks due 2026-05-04:",
        "- text Verizon guy (assignee Dhruv Addanki)",
        "- Finish Noval notes and post story (assignee Dhruv Addanki)",
        "- script video (assignee Dhruv Addanki)",
        "- Call Rohan (assignee Dhruv Addanki)"
      ].join("\n")
    );
  });

  it("creates an Asana task and calendar event through the deterministic compound shortcut", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T15:47:00.000Z"));
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockImplementation(async (toolName: string, rawInput: any) => {
        if (toolName === "asana_create_task") {
          return {
            ok: true,
            data: {
              gid: "task_1",
              name: rawInput.name,
              dueOn: rawInput.dueOn,
              completed: false
            },
            userMessage: `Created: ${rawInput.name}\nDue: ${rawInput.dueOn}`
          };
        }
        if (toolName === "calendar_create_event") {
          return {
            ok: true,
            data: {
              id: "event_1",
              title: rawInput.title,
              start: rawInput.start,
              end: rawInput.end
            },
            userMessage: `Booked: ${rawInput.title} at Thu, May 21, 2026 7:00 PM EDT.`
          };
        }
        return { ok: false, error: "unexpected tool" };
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
        findFirst: vi.fn(async () => ({ id: "conversation_1", userId: "user_1" }))
      },
      message: {
        create: vi.fn(async () => undefined),
        findMany: vi.fn(async () => [])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "Add check medical insurance with mom as asana task due today and also add it to calendar at 7-7:30"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_create_task",
      { name: "check medical insurance with mom", dueOn: "2026-05-21" },
      expect.objectContaining({
        latestUserMessage:
          "Add check medical insurance with mom as asana task due today and also add it to calendar at 7-7:30"
      }),
      { force: true }
    );
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "calendar_create_event",
      {
        title: "check medical insurance with mom",
        start: "2026-05-21T23:00:00.000Z",
        end: "2026-05-21T23:30:00.000Z"
      },
      expect.anything(),
      { force: true }
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      [
        "Asana: Created: check medical insurance with mom",
        "Calendar: Booked: check medical insurance with mom at Thu, May 21, 2026 7:00 PM EDT."
      ].join("\n")
    );
  });

  it("reports clean partial success when compound Asana creation fails but Calendar succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T15:47:00.000Z"));
    vi.spyOn(ToolExecutor.prototype, "executeToolCall").mockImplementation(
      async (toolName: string, rawInput: any) => {
        if (toolName === "asana_create_task") {
          return {
            ok: false,
            error: "ASANA_WORKSPACE_SELECTION_REQUIRED",
            userMessage: "You have multiple Asana workspaces. Ask me to list Asana workspaces and pick one."
          };
        }
        if (toolName === "calendar_create_event") {
          return {
            ok: true,
            data: { id: "event_1", title: rawInput.title, start: rawInput.start },
            userMessage: `Booked: ${rawInput.title} at Thu, May 21, 2026 7:00 PM EDT.`
          };
        }
        return { ok: false, error: "unexpected tool" };
      }
    );

    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          timezone: "America/New_York"
        }))
      },
      conversation: {
        findFirst: vi.fn(async () => ({ id: "conversation_1", userId: "user_1" }))
      },
      message: {
        create: vi.fn(async () => undefined),
        findMany: vi.fn(async () => [])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "Add check medical insurance with mom as asana task due today and also add it to calendar at 7-7:30"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Calendar: Booked: check medical insurance with mom")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Asana: You have multiple Asana workspaces")
    );
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Completed: Tool")
    );
  });

  it("builds a context-backed focus plan when live Calendar and Asana fail", async () => {
    vi.spyOn(ToolExecutor.prototype, "executeToolCall").mockImplementation(async (toolName: string) => {
      if (toolName === "calendar_list_events") {
        return {
          ok: false,
          error: "GOOGLE_AUTH_REQUIRED",
          userMessage: "Reconnect Google Calendar first."
        };
      }
      if (toolName === "asana_list_my_tasks") {
        return {
          ok: false,
          error: "ASANA_WORKSPACE_SELECTION_REQUIRED",
          userMessage: "You have multiple Asana workspaces. Ask me to list Asana workspaces and pick one."
        };
      }
      return { ok: false, error: "unexpected tool" };
    });
    vi.spyOn(ObsidianContextGraphService.prototype, "search").mockResolvedValue([
      {
        pcgId: "project_scann",
        label: "Scann.ai",
        type: "project",
        summary: "AI-driven 3D body scanning and adaptive fitness product.",
        aliases: [],
        evidenceCount: 5,
        confidence: 0.99,
        path: "/vault/Personal Context Graph/Scann.ai.md",
        score: 3
      } as any
    ]);

    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          timezone: "America/New_York"
        }))
      },
      conversation: {
        findFirst: vi.fn(async () => ({ id: "conversation_1", userId: "user_1" }))
      },
      message: {
        create: vi.fn(async () => undefined),
        findMany: vi.fn(async () => [])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "What should I focus on today based on my calendar, Asana, and context graph?"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("read-only context graph only")
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Scann.ai")
    );
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("context_graph_search")
    );
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Completed:")
    );
  });

  it("completes a single listed Asana task without confirmation", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: {
          gid: "task_1",
          name: "test 1",
          completed: true
        }
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
        findMany: vi.fn(async () => [
          {
            key: "last_visible_asana_task_list",
            value: {
              scopeLabel: "My Tasks",
              tasks: [
                { taskGid: "task_1", name: "test 1" },
                { taskGid: "task_2", name: "test 2" }
              ]
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "complete the first one"
    });

    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_update_task",
      {
        taskGid: "task_1",
        completed: true
      },
      expect.objectContaining({
        latestUserMessage: "complete the first one"
      }),
      { force: true }
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Completed 1 Asana task: test 1."
    );
  });

  it("asks to reload before completing from a stale Asana list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T20:30:00.000Z"));
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");

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
        findMany: vi.fn(async () => [
          {
            key: "last_visible_asana_task_list",
            value: {
              tasks: [{ taskGid: "task_1", name: "test 1" }]
            },
            updatedAt: new Date("2026-05-03T18:00:00.000Z")
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "complete that task"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "That Asana task list is stale. Ask me to show the tasks again before completing them."
    );
  });

  it("does not silently complete an oversized visible Asana list", async () => {
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");
    const tasks = Array.from({ length: 25 }, (_, index) => ({
      taskGid: `task_${index + 1}`,
      name: `task ${index + 1}`
    }));

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
        findMany: vi.fn(async () => [
          {
            key: "last_visible_asana_task_list",
            value: {
              tasks,
              returnedCount: 50,
              storedCount: 25
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "complete those listed tasks"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "That Asana list is too large for an automatic bulk completion. Narrow the list or say complete the first 25 shown."
    );
  });

  it("handles concrete Asana completion before model fallback in compound requests", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: {
          updated: [
            { gid: "task_1", name: "test 1", completed: true },
            { gid: "task_2", name: "test 2", completed: true }
          ]
        }
      });
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Calendar tomorrow: no events found.",
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
        findMany: vi.fn(async () => [
          {
            key: "last_visible_asana_task_list",
            value: {
              tasks: [
                { taskGid: "task_1", name: "test 1" },
                { taskGid: "task_2", name: "test 2" }
              ]
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      notionAccount: { findUnique: vi.fn(async () => null) },
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
      text: "mark those Asana tasks complete and check my calendar tomorrow"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_bulk_update_tasks",
      expect.objectContaining({
        taskGids: ["task_1", "task_2"],
        completed: true,
        source: "recent_list"
      }),
      expect.objectContaining({
        latestUserMessage: "mark those Asana tasks complete and check my calendar tomorrow"
      }),
      { force: true }
    );
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(String(runResponseLoopMock.mock.calls[0]?.[0]?.instructions)).toContain(
      "Backend already completed this Asana request"
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Completed 2 Asana tasks: test 1; test 2.\n\nCalendar tomorrow: no events found."
    );
  });

  it("reads a same-message Asana list before completing those tasks", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockImplementation(async (toolName: string) => {
        if (toolName === "asana_list_project_tasks") {
          return {
            ok: true,
            data: [
              {
                gid: "fresh_1",
                name: "Fresh Scanis task 1",
                completed: false,
                dueOn: "2026-02-18",
                projects: [{ gid: "project_1", name: "Scanis-OLD" }]
              },
              {
                gid: "fresh_2",
                name: "Fresh Scanis task 2",
                completed: false,
                dueOn: "2026-02-23",
                projects: [{ gid: "project_1", name: "Scanis-OLD" }]
              }
            ]
          };
        }
        if (toolName === "asana_bulk_update_tasks") {
          return {
            ok: true,
            data: {
              updated: [
                { gid: "fresh_1", name: "Fresh Scanis task 1", completed: true },
                { gid: "fresh_2", name: "Fresh Scanis task 2", completed: true }
              ]
            }
          };
        }
        return { ok: false, userMessage: "Unexpected tool" };
      });
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Calendar tomorrow: no events found.",
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
        findMany: vi.fn(async () => [
          {
            key: "last_visible_asana_task_list",
            value: {
              tasks: [
                { taskGid: "old_1", name: "Old visible task" },
                { taskGid: "old_2", name: "Another old visible task" }
              ]
            },
            updatedAt: new Date()
          }
        ]),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      notionAccount: { findUnique: vi.fn(async () => null) },
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
      text: "list all open tasks in Scanis-OLD due before today. mark those Asana tasks complete and check my calendar tomorrow"
    });

    expect(executeToolCallSpy).toHaveBeenNthCalledWith(
      1,
      "asana_list_project_tasks",
      expect.objectContaining({
        projectName: "Scanis-OLD",
        completed: false,
        dueBefore: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
      }),
      expect.objectContaining({
        latestUserMessage:
          "list all open tasks in Scanis-OLD due before today. mark those Asana tasks complete and check my calendar tomorrow"
      })
    );
    expect(executeToolCallSpy).toHaveBeenNthCalledWith(
      2,
      "asana_bulk_update_tasks",
      expect.objectContaining({
        taskGids: ["fresh_1", "fresh_2"],
        completed: true,
        source: "recent_list"
      }),
      expect.objectContaining({
        latestUserMessage:
          "list all open tasks in Scanis-OLD due before today. mark those Asana tasks complete and check my calendar tomorrow"
      }),
      { force: true }
    );
    expect(executeToolCallSpy).not.toHaveBeenCalledWith(
      "asana_bulk_update_tasks",
      expect.objectContaining({ taskGids: ["old_1", "old_2"] }),
      expect.anything(),
      expect.anything()
    );
    expect(String(runResponseLoopMock.mock.calls[0]?.[0]?.instructions)).toContain(
      "Do not call any Asana tools"
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Completed 2 Asana tasks: Fresh Scanis task 1 (Scanis-OLD • due 2026-02-18); Fresh Scanis task 2 (Scanis-OLD • due 2026-02-23).\n\nCalendar tomorrow: no events found."
    );
  });

  it("routes Asana project-list requests to projects, not My Tasks", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          { gid: "project_1", name: "Scanis", teamName: "Growth" },
          { gid: "project_2", name: "Content" }
        ]
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
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "what projects are in asana right now"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_projects",
      {},
      expect.objectContaining({
        latestUserMessage: "what projects are in asana right now"
      })
    );
    expect(executeToolCallSpy).not.toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.anything(),
      expect.anything()
    );
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Scanis")
    );
  });

  it("does not complete listed Asana tasks without a recent backend list", async () => {
    const executeToolCallSpy = vi.spyOn(ToolExecutor.prototype, "executeToolCall");
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
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "complete the listed tasks"
    });

    expect(executeToolCallSpy).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "I don't have a recent Asana task list to apply that to. Ask me to show the tasks first."
    );
  });

  it("short-circuits Asana date-history requests across all projects", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            gid: "task_1",
            name: "April task",
            completed: false,
            projects: [{ gid: "project_1", name: "Business" }]
          }
        ]
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
        findMany: vi.fn(async () => [{ role: "assistant", content: "Earlier Asana reply" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [
          {
            key: "recent_asana_tasks",
            value: [{ taskGid: "task_0", name: "old task" }],
            updatedAt: new Date("2026-04-23T15:00:00.000Z")
          }
        ])
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
      text: "Check my tasks from April 11th across all projects"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_my_tasks",
      expect.objectContaining({
        dueAfter: "2026-04-11",
        dueBefore: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        completed: false,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({
        latestUserMessage: "Check my tasks from April 11th across all projects"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Here are the open Asana tasks overdue from Apr 11:")
    );
  });

  it("short-circuits latest completed task requests using recent project context", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            gid: "task_2",
            name: "test 2",
            completed: true,
            completedAt: "2026-04-23T19:16:00.000Z"
          }
        ]
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
        findMany: vi.fn(async () => [
          {
            role: "assistant",
            content: "Here are the open Asana tasks in Scanis:\n\n1. test 1\n2. test 2"
          }
        ])
      },
      memoryEntry: {
        findMany: vi.fn(async () => [
          {
            key: "recent_asana_projects",
            value: [{ projectGid: "project_1", name: "Scanis" }],
            updatedAt: new Date("2026-04-23T15:00:00.000Z")
          }
        ])
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
      text: "Check my latest completed task in Scanis"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_project_tasks",
      expect.objectContaining({
        projectGid: "project_1",
        completed: true,
        sortBy: "completedAt",
        sortDirection: "desc",
        limit: 1
      }),
      expect.objectContaining({
        latestUserMessage: "Check my latest completed task in Scanis"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Latest completed Asana task in Scanis:")
    );
  });

  it("does not require Google for weak schedule wording", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "Yeah, that sounds packed.",
      toolRounds: 0
    });

    const prisma = {
      user: {
        upsert: vi.fn(async () => ({
          id: "user_1",
          whatsappPhone: "+15555550100",
          googleEmail: null,
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
        findMany: vi.fn(async () => [{ role: MessageRole.USER, content: "schedule looks packed" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
      },
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) },
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
      text: "schedule looks packed"
    });

    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalledWith(
      "+15555550100",
      expect.stringMatching(/^Connect Google first:/)
    );
  });

  it("routes send-it without a pending action through the response loop", async () => {
    runResponseLoopMock.mockResolvedValue({
      assistantMessage: "What would you like me to send?",
      toolRounds: 0
    });
    const executePendingActionSpy = vi.spyOn(ToolExecutor.prototype, "executePendingAction");

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
        findMany: vi.fn(async () => [{ role: MessageRole.USER, content: "send it" }])
      },
      memoryEntry: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => undefined)
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
      text: "send it"
    });

    expect(executePendingActionSpy).not.toHaveBeenCalled();
    expect(runResponseLoopMock).toHaveBeenCalledOnce();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "What would you like me to send?"
    );
  });

  it("short-circuits named Asana project task reads with projectName", async () => {
    const executeToolCallSpy = vi
      .spyOn(ToolExecutor.prototype, "executeToolCall")
      .mockResolvedValue({
        ok: true,
        data: [
          {
            gid: "task_1",
            name: "Scanis project task",
            completed: false
          }
        ]
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
      text: "show tasks in Scanis"
    });

    expect(executeToolCallSpy).toHaveBeenCalledWith(
      "asana_list_project_tasks",
      expect.objectContaining({
        projectName: "Scanis",
        completed: false,
        limit: 50,
        sortBy: "due",
        sortDirection: "asc"
      }),
      expect.objectContaining({
        latestUserMessage: "show tasks in Scanis"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      expect.stringContaining("Scanis project task")
    );
  });
});
