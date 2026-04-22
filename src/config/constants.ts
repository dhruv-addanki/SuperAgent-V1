export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
] as const;

export const ASANA_SCOPES = [
  "attachments:read",
  "attachments:write",
  "attachments:delete",
  "custom_fields:read",
  "custom_fields:write",
  "projects:write",
  "projects:delete",
  "tasks:read",
  "tasks:write",
  "tasks:delete",
  "stories:read",
  "stories:write",
  "tags:read",
  "tags:write",
  "teams:read",
  "projects:read",
  "workspaces:read",
  "users:read"
] as const;

export const DEFAULT_TIMEZONE = "America/New_York";
export const SHORT_TERM_MESSAGE_LIMIT = 20;
export const WHATSAPP_TEXT_LIMIT = 4096;
