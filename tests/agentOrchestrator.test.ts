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
        limit: 20
      }),
      expect.objectContaining({
        latestUserMessage: "show my asana tasks due today"
      })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Your Asana tasks due today:\n\n1. Test task 1"
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
      expect.objectContaining({ completed: false, limit: 20 }),
      expect.objectContaining({ latestUserMessage: "show my asana tasks due today" })
    );
    expect(runResponseLoopMock).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+15555550100",
      "Your Asana tasks due today:\n\n1. Voice task"
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
});
