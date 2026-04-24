import { afterEach, describe, expect, it, vi } from "vitest";

describe("app Redis queue configuration", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalUseRedisQueue = process.env.USE_REDIS_QUEUE;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalUseRedisQueue === undefined) {
      delete process.env.USE_REDIS_QUEUE;
    } else {
      process.env.USE_REDIS_QUEUE = originalUseRedisQueue;
    }
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("../src/modules/queue/queue");
    vi.doUnmock("../src/modules/queue/jobs");
  });

  it("does not create the BullMQ queue by default", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.USE_REDIS_QUEUE;

    const createWhatsAppInboundQueue = vi.fn(() => ({
      add: vi.fn(),
      close: vi.fn()
    }));

    vi.doMock("../src/modules/queue/queue", () => ({
      createWhatsAppInboundQueue
    }));
    vi.doMock("../src/modules/queue/jobs", () => ({
      registerWhatsappWorker: vi.fn()
    }));

    const { buildApp } = await import("../src/app/app");
    const app = await buildApp({
      prisma: {} as any,
      responsesClient: { createResponse: vi.fn() } as any,
      whatsappService: {
        sendTextMessage: vi.fn(),
        sendTypingIndicator: vi.fn()
      } as any
    });

    expect(createWhatsAppInboundQueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates the BullMQ queue when USE_REDIS_QUEUE is true", async () => {
    process.env.NODE_ENV = "development";
    process.env.USE_REDIS_QUEUE = "true";

    const queue = {
      add: vi.fn(),
      close: vi.fn()
    };
    const createWhatsAppInboundQueue = vi.fn(() => queue);

    vi.doMock("../src/modules/queue/queue", () => ({
      createWhatsAppInboundQueue
    }));
    vi.doMock("../src/modules/queue/jobs", () => ({
      registerWhatsappWorker: vi.fn()
    }));

    const { buildApp } = await import("../src/app/app");
    const app = await buildApp({
      prisma: {} as any,
      responsesClient: { createResponse: vi.fn() } as any,
      whatsappService: {
        sendTextMessage: vi.fn(),
        sendTypingIndicator: vi.fn()
      } as any,
      startWorkers: false
    });

    expect(createWhatsAppInboundQueue).toHaveBeenCalledOnce();
    await app.close();
    expect(queue.close).toHaveBeenCalledOnce();
  });
});
