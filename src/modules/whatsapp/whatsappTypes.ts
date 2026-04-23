export interface NormalizedWhatsAppInboundTextMessage {
  kind: "text";
  messageId: string;
  from: string;
  text: string;
  timestamp?: string;
  raw: unknown;
}

export interface NormalizedWhatsAppInboundAudioMessage {
  kind: "audio";
  messageId: string;
  from: string;
  mediaId: string;
  mimeType?: string;
  sha256?: string;
  isVoice?: boolean;
  timestamp?: string;
  raw: unknown;
}

export type NormalizedWhatsAppInboundMessage =
  | NormalizedWhatsAppInboundTextMessage
  | NormalizedWhatsAppInboundAudioMessage;

export type WhatsAppInboundMessagePayload = NormalizedWhatsAppInboundMessage;

export interface NormalizedWhatsAppUnsupportedMessage {
  messageId?: string;
  from?: string;
  timestamp?: string;
  type: string;
  raw: unknown;
}

export interface NormalizedWhatsAppStatus {
  messageId: string;
  recipientId?: string;
  status: string;
  timestamp?: string;
  raw: unknown;
}

export interface ParsedWhatsAppWebhook {
  messages: NormalizedWhatsAppInboundMessage[];
  unsupportedMessages: NormalizedWhatsAppUnsupportedMessage[];
  statuses: NormalizedWhatsAppStatus[];
}

export interface SendTextResult {
  messageId?: string;
}

export interface SendTypingIndicatorResult {
  success: boolean;
}
