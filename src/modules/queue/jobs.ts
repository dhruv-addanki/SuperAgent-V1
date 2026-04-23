import { Worker } from "bullmq";
import { logger } from "../../config/logger";
import { getBullMQConnectionOptions } from "../../lib/redis";
import type { AgentOrchestrator } from "../agent/agentOrchestrator";
import { WHATSAPP_INBOUND_QUEUE, type InboundWhatsAppJobData } from "./queue";

export function registerWhatsappWorker(agent: AgentOrchestrator): Worker<InboundWhatsAppJobData> {
  const worker = new Worker<InboundWhatsAppJobData>(
    WHATSAPP_INBOUND_QUEUE,
    async (job) => {
      await agent.processInboundWhatsAppMessage(job.data);
    },
    {
      connection: getBullMQConnectionOptions(),
      concurrency: 4
    }
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "WhatsApp inbound job failed");
  });

  return worker;
}
