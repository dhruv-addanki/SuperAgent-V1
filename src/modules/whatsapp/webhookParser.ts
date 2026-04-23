import type {
  NormalizedWhatsAppInboundMessage,
  NormalizedWhatsAppStatus,
  NormalizedWhatsAppUnsupportedMessage,
  ParsedWhatsAppWebhook
} from "./whatsappTypes";

export function parseWhatsAppWebhook(payload: any): ParsedWhatsAppWebhook {
  const messages: NormalizedWhatsAppInboundMessage[] = [];
  const statuses: NormalizedWhatsAppStatus[] = [];
  const unsupportedMessages: NormalizedWhatsAppUnsupportedMessage[] = [];

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;

      for (const status of value?.statuses ?? []) {
        if (!status?.id || !status?.status) continue;
        statuses.push({
          messageId: status.id,
          recipientId: status.recipient_id,
          status: status.status,
          timestamp: status.timestamp,
          raw: status
        });
      }

      for (const message of value?.messages ?? []) {
        if (message?.type === "text" && message.text?.body && message.from && message.id) {
          messages.push({
            kind: "text",
            messageId: message.id,
            from: message.from,
            text: message.text.body,
            timestamp: message.timestamp,
            raw: message
          });
          continue;
        }

        if (message?.type === "audio" && message.audio?.id && message.from && message.id) {
          messages.push({
            kind: "audio",
            messageId: message.id,
            from: message.from,
            mediaId: message.audio.id,
            mimeType: message.audio.mime_type,
            sha256: message.audio.sha256,
            isVoice: message.audio.voice,
            timestamp: message.timestamp,
            raw: message
          });
          continue;
        }

        unsupportedMessages.push({
          messageId: message?.id,
          from: message?.from,
          timestamp: message?.timestamp,
          type: message?.type ?? "unknown",
          raw: message
        });
      }
    }
  }

  return { messages, statuses, unsupportedMessages };
}
