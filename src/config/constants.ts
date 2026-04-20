export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents"
] as const;

export const DEFAULT_TIMEZONE = "America/New_York";
export const SHORT_TERM_MESSAGE_LIMIT = 20;
export const WHATSAPP_TEXT_LIMIT = 4096;
