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
  if (error instanceof Error) return error.message;
  return String(error);
}
