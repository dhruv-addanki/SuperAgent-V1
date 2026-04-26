import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const redisMocks = vi.hoisted(() => ({
  checkPhoneRateLimit: vi.fn(),
  markWebhookEventProcessed: vi.fn()
}));

vi.mock("../src/lib/redis", () => ({
  checkPhoneRateLimit: redisMocks.checkPhoneRateLimit,
  markWebhookEventProcessed: redisMocks.markWebhookEventProcessed
}));

import { registerWhatsAppWebhookRoutes } from "../src/routes/whatsappWebhook";

describe("WhatsApp webhook route", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
    vi.clearAllMocks();
  });

  it("enqueues audio messages with the WhatsApp message ID as the job ID", async () => {
    redisMocks.checkPhoneRateLimit.mockResolvedValue(true);
    redisMocks.markWebhookEventProcessed.mockResolvedValue(true);

    const app = Fastify({ logger: false });
    apps.push(app);

    const queue = {
      add: vi.fn(async () => undefined)
    };

    await registerWhatsAppWebhookRoutes(app, {
      agent: { processInboundWhatsAppMessage: vi.fn() } as any,
      queue: queue as any
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.audio",
                      from: "15555550100",
                      timestamp: "1776700000",
                      type: "audio",
                      audio: {
                        id: "audio-id",
                        mime_type: "audio/ogg; codecs=opus",
                        sha256: "hash",
                        voice: true
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "inbound-audio",
      expect.objectContaining({
        kind: "audio",
        messageId: "wamid.audio",
        mediaId: "audio-id",
        isVoice: true
      }),
      { jobId: "wamid.audio" }
    );
  });

  it("enqueues image messages with the WhatsApp message ID as the job ID", async () => {
    redisMocks.checkPhoneRateLimit.mockResolvedValue(true);
    redisMocks.markWebhookEventProcessed.mockResolvedValue(true);

    const app = Fastify({ logger: false });
    apps.push(app);

    const queue = {
      add: vi.fn(async () => undefined)
    };

    await registerWhatsAppWebhookRoutes(app, {
      agent: { processInboundWhatsAppMessage: vi.fn() } as any,
      queue: queue as any
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.image",
                      from: "15555550100",
                      timestamp: "1776700000",
                      type: "image",
                      image: {
                        id: "image-id",
                        mime_type: "image/png",
                        sha256: "image-hash",
                        caption: "summarize this"
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "inbound-image",
      expect.objectContaining({
        kind: "image",
        messageId: "wamid.image",
        mediaId: "image-id",
        mimeType: "image/png",
        caption: "summarize this"
      }),
      { jobId: "wamid.image" }
    );
  });

  it("processes image messages inline when no queue is configured", async () => {
    redisMocks.checkPhoneRateLimit.mockResolvedValue(true);
    redisMocks.markWebhookEventProcessed.mockResolvedValue(true);

    const app = Fastify({ logger: false });
    apps.push(app);
    const agent = {
      processInboundWhatsAppMessage: vi.fn(async () => undefined)
    };

    await registerWhatsAppWebhookRoutes(app, {
      agent: agent as any
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.inline-image",
                      from: "15555550100",
                      type: "image",
                      image: {
                        id: "image-id",
                        mime_type: "image/webp"
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(agent.processInboundWhatsAppMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "image",
        messageId: "wamid.inline-image",
        mediaId: "image-id"
      })
    );
  });
});
