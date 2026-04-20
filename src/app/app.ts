import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Worker, Queue } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { createOpenAIClient, type ResponsesClient } from "../lib/openaiClient";
import { userMessageForError } from "../lib/errors";
import { prisma as defaultPrisma } from "../modules/db/prisma";
import { AgentOrchestrator } from "../modules/agent/agentOrchestrator";
import { GoogleOAuthService } from "../modules/google/googleOAuthService";
import { WhatsAppService } from "../modules/whatsapp/whatsappService";
import { createWhatsAppInboundQueue, type InboundWhatsAppJobData } from "../modules/queue/queue";
import { registerWhatsappWorker } from "../modules/queue/jobs";
import { registerHealthRoutes } from "../routes/health";
import { registerGoogleAuthRoutes } from "../routes/authGoogle";
import { registerWhatsAppWebhookRoutes } from "../routes/whatsappWebhook";

export interface BuildAppOptions {
  prisma?: PrismaClient;
  responsesClient?: ResponsesClient;
  whatsappService?: WhatsAppService;
  googleOAuthService?: GoogleOAuthService;
  queue?: Queue<InboundWhatsAppJobData> | null;
  startWorkers?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: false
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute"
  });

  const prisma = options.prisma ?? defaultPrisma;
  const responsesClient = options.responsesClient ?? createOpenAIClient();
  const whatsappService = options.whatsappService ?? new WhatsAppService();
  const agent = new AgentOrchestrator(prisma, responsesClient, whatsappService);
  const googleOAuthService = options.googleOAuthService ?? new GoogleOAuthService(prisma);
  const queue =
    options.queue === null
      ? undefined
      : (options.queue ?? (env.NODE_ENV === "test" ? undefined : createWhatsAppInboundQueue()));

  let worker: Worker<InboundWhatsAppJobData> | undefined;
  if (queue && options.startWorkers !== false && env.NODE_ENV !== "test") {
    worker = registerWhatsappWorker(agent);
  }

  app.setErrorHandler((error, _request, reply) => {
    const appError = error as { statusCode?: number; name?: string; message?: string };
    logger.error({ error }, "Unhandled request error");
    const statusCode =
      appError.statusCode && appError.statusCode >= 400 ? appError.statusCode : 500;
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : (appError.name ?? "Error"),
      message: statusCode >= 500 ? userMessageForError(error) : (appError.message ?? "Bad request")
    });
  });

  await registerHealthRoutes(app);
  await registerGoogleAuthRoutes(app, googleOAuthService);
  await registerWhatsAppWebhookRoutes(app, { agent, queue });

  app.addHook("onClose", async () => {
    await worker?.close();
    await queue?.close();
  });

  return app;
}
