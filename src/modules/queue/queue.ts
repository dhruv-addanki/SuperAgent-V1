import { Queue } from "bullmq";
import { getBullMQConnectionOptions } from "../../lib/redis";

export const WHATSAPP_INBOUND_QUEUE = "whatsapp-inbound";

export interface InboundWhatsAppJobData {
  from: string;
  text: string;
  messageId?: string;
  rawPayload?: unknown;
}

export function createWhatsAppInboundQueue(): Queue<InboundWhatsAppJobData> {
  return new Queue<InboundWhatsAppJobData>(WHATSAPP_INBOUND_QUEUE, {
    connection: getBullMQConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: 500,
      removeOnFail: 1000
    }
  });
}
