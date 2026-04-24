import { afterEach, describe, expect, it, vi } from "vitest";

const runResponseLoopMock = vi.fn();

vi.mock("../src/modules/agent/responseLoop", () => ({
  runResponseLoop: (...args: any[]) => runResponseLoopMock(...args)
}));

import { AgentOrchestrator } from "../src/modules/agent/agentOrchestrator";
import { ToolExecutor } from "../src/modules/agent/toolExecutor";
import { UserFacingError } from "../src/lib/errors";

describe("agent orchestrator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runResponseLoopMock.mockReset();
  });

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
    expect(runResponseLoopMock.mock.calls[0][0].instructions).toContain(
      "Structured conversation context:"
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
      }))
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
      }))
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
              "Across all calendars today:\n• All day — Systems Class Ex4 Due (Dhruv's tasks - My workspace (via Asana))"
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
          { role: "assistant", content: "Here are the open Asana tasks in Scanis:\n\n1. test 1\n2. test 2" }
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
        findMany: vi.fn(async () => [
          { role: "assistant", content: "Earlier Asana reply" }
        ])
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
        dueOn: "2026-04-11",
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
      expect.stringContaining("Here are the open Asana tasks due on Apr 11:")
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
          { role: "assistant", content: "Here are the open Asana tasks in Scanis:\n\n1. test 1\n2. test 2" }
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
});
