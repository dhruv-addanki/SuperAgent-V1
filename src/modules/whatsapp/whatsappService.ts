import crypto from "node:crypto";
import { env } from "../../config/env";
import { WHATSAPP_TEXT_LIMIT } from "../../config/constants";
import { ExternalApiError } from "../../lib/errors";
import type { SendTextResult, SendTypingIndicatorResult } from "./whatsappTypes";

export class WhatsAppService {
  private get messagesUrl(): string {
    return `https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  }

  async sendTextMessage(to: string, body: string): Promise<SendTextResult> {
    const safeBody = this.formatText(body);

    if (env.NODE_ENV !== "production" && env.WHATSAPP_ACCESS_TOKEN.startsWith("dev-")) {
      return { messageId: `dev-${Date.now()}` };
    }

    const response = await fetch(this.messagesUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: false,
          body: safeBody
        }
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ExternalApiError(
        "whatsapp",
        "I wasn't able to send the WhatsApp reply.",
        new Error(errorBody)
      );
    }

    const data = (await response.json()) as any;
    return { messageId: data.messages?.[0]?.id };
  }

  async sendTypingIndicator(messageId: string): Promise<SendTypingIndicatorResult> {
    if (!messageId) {
      return { success: false };
    }

    if (env.NODE_ENV !== "production" && env.WHATSAPP_ACCESS_TOKEN.startsWith("dev-")) {
      return { success: true };
    }

    const response = await fetch(this.messagesUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: {
          type: "text"
        }
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ExternalApiError(
        "whatsapp",
        "I wasn't able to send the WhatsApp typing indicator.",
        new Error(errorBody)
      );
    }

    return { success: true };
  }

  formatText(body: string): string {
    const compact = body.trim().replace(/\n{3,}/g, "\n\n");
    if (compact.length <= WHATSAPP_TEXT_LIMIT) return compact;
    return `${compact.slice(0, WHATSAPP_TEXT_LIMIT - 20).trimEnd()}\n\n[truncated]`;
  }
}

export function verifyWhatsAppSignature(rawBody: string, signatureHeader?: string): boolean {
  if (!env.WHATSAPP_APP_SECRET) return true;
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", env.WHATSAPP_APP_SECRET)
    .update(rawBody)
    .digest("hex")}`;

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signatureHeader);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}
