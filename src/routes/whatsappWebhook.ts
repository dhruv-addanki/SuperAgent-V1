import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { checkPhoneRateLimit, markWebhookEventProcessed } from "../lib/redis";
import type { AgentOrchestrator } from "../modules/agent/agentOrchestrator";
import { parseWhatsAppWebhook } from "../modules/whatsapp/webhookParser";
import type { InboundWhatsAppJobData } from "../modules/queue/queue";
import { whatsappVerifyQuerySchema } from "../schemas/apiSchemas";

export interface WhatsAppWebhookDeps {
  agent: AgentOrchestrator;
  queue?: Queue<InboundWhatsAppJobData>;
}

export async function registerWhatsAppWebhookRoutes(
  app: FastifyInstance,
  deps: WhatsAppWebhookDeps
): Promise<void> {
  app.get("/webhooks/whatsapp", async (request, reply) => {
    const query = whatsappVerifyQuerySchema.parse(request.query);

    if (
      query["hub.mode"] === "subscribe" &&
      query["hub.verify_token"] === env.WHATSAPP_VERIFY_TOKEN
    ) {
      return reply.type("text/plain").send(query["hub.challenge"]);
    }

    return reply.code(403).send({ error: "Invalid verify token" });
  });

  app.post("/webhooks/whatsapp", async (request, reply) => {
    // TODO: Wire raw-body capture before this route and call verifyWhatsAppSignature for production.
    const parsed = parseWhatsAppWebhook(request.body);

    for (const status of parsed.statuses) {
      logger.info(
        {
          messageId: status.messageId,
          recipientId: status.recipientId,
          status: status.status
        },
        "WhatsApp delivery status"
      );
    }

    for (const unsupported of parsed.unsupportedMessages) {
      logger.info(
        {
          messageId: unsupported.messageId,
          from: unsupported.from,
          type: unsupported.type
        },
        "Ignored unsupported WhatsApp message"
      );
    }

    for (const message of parsed.messages) {
      void enqueueOrProcessMessage(deps, message);
    }

    return reply.code(200).send({ received: true });
  });
}

async function enqueueOrProcessMessage(
  deps: WhatsAppWebhookDeps,
  data: InboundWhatsAppJobData
): Promise<void> {
  try {
    const allowed = await checkPhoneRateLimit(data.from, env.RATE_LIMIT_PER_MINUTE);
    if (!allowed) {
      logger.warn({ from: data.from }, "Rate limited WhatsApp sender");
      return;
    }
  } catch (error) {
    logger.warn({ error }, "Redis rate limit check failed; continuing");
  }

  try {
    if (data.messageId) {
      const firstSeen = await markWebhookEventProcessed(data.messageId);
      if (!firstSeen) return;
    }
  } catch (error) {
    logger.warn({ error }, "Redis idempotency check failed; continuing");
  }

  if (deps.queue) {
    try {
      await deps.queue.add(data.kind === "audio" ? "inbound-audio" : "inbound-text", data, {
        jobId: data.messageId
      });
      return;
    } catch (error) {
      logger.warn({ error }, "Failed to enqueue WhatsApp message; processing inline");
    }
  }

  setImmediate(() => {
    deps.agent.processInboundWhatsAppMessage(data).catch((error) => {
      logger.error({ error }, "Inline WhatsApp message processing failed");
    });
  });
}
