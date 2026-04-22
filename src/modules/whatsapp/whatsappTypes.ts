export interface NormalizedWhatsAppInboundMessage {
  messageId: string;
  from: string;
  text: string;
  timestamp?: string;
  type: "text";
  raw: unknown;
}

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
