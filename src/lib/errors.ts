export class UserFacingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly userMessage: string
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

export class AuthRequiredError extends UserFacingError {
  constructor(authUrl: string, provider = "Google", codePrefix = "GOOGLE") {
    super(
      `${provider} account is not connected`,
      `${codePrefix}_AUTH_REQUIRED`,
      `Connect ${provider} first: ${authUrl}`
    );
  }
}

export class ReauthRequiredError extends UserFacingError {
  constructor(
    authUrl: string,
    reason: string,
    provider = "Google",
    codePrefix = "GOOGLE"
  ) {
    super(`${provider} account needs additional access`, `${codePrefix}_REAUTH_REQUIRED`, `${reason}: ${authUrl}`);
  }
}

export class ExternalApiError extends UserFacingError {
  constructor(service: string, userMessage: string, cause?: unknown) {
    super(`${service} API request failed`, `${service.toUpperCase()}_API_ERROR`, userMessage);
    this.cause = cause;
  }
}

export function userMessageForError(error: unknown): string {
  if (error instanceof UserFacingError) return error.userMessage;
  return "I hit a problem handling that. Please try again.";
}

export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    const details = errorDetails(error);
    return details.length ? `${error.message} (${details.join("; ")})` : error.message;
  }
  return String(error);
}

function errorDetails(error: Error): string[] {
  const details: string[] = [];
  const coded = error as Error & {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown; data?: unknown };
    cause?: unknown;
  };

  if (coded.code !== undefined) details.push(`code: ${String(coded.code)}`);
  if (coded.status !== undefined) details.push(`status: ${String(coded.status)}`);
  if (coded.response?.status !== undefined) {
    details.push(`responseStatus: ${String(coded.response.status)}`);
  }

  const responseMessage = extractResponseMessage(coded.response?.data);
  if (responseMessage) details.push(`response: ${responseMessage}`);

  const cause = serializeCause(coded.cause);
  if (cause) details.push(`cause: ${cause}`);

  return details;
}

function serializeCause(cause: unknown): string | null {
  if (!cause) return null;
  if (cause instanceof Error) {
    const details = errorDetails(cause);
    return details.length ? `${cause.message} (${details.join("; ")})` : cause.message;
  }
  if (typeof cause === "string") return cause;
  return extractResponseMessage(cause) ?? safeJson(cause) ?? String(cause);
}

function extractResponseMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (typeof record.message === "string") return record.message;
  if (typeof record.error_description === "string") return record.error_description;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
    if (typeof nested.status === "string") return nested.status;
  }

  return null;
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
