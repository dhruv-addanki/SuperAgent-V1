import { env } from "../../config/env";

export const ASANA_OAUTH_AUTHORIZE_URL = "https://app.asana.com/-/oauth_authorize";
export const ASANA_OAUTH_TOKEN_URL = "https://app.asana.com/-/oauth_token";

export interface AsanaTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  data?: {
    gid?: string;
    name?: string;
    email?: string;
  };
  error?: string;
  error_description?: string;
}

export async function exchangeAsanaToken(
  params: Record<string, string>
): Promise<AsanaTokenResponse> {
  const response = await fetch(ASANA_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new globalThis.URLSearchParams(params).toString()
  });

  const data = (await response.json().catch(() => ({}))) as AsanaTokenResponse;
  if (!response.ok) {
    const detail = data.error_description ?? data.error ?? `HTTP ${response.status}`;
    throw new Error(`Asana OAuth token exchange failed: ${detail}`);
  }

  return data;
}

export function buildAsanaAuthUrl(state: string, scopes: readonly string[]): string {
  const url = new URL(ASANA_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.ASANA_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.ASANA_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scopes.join(" "));
  return url.toString();
}

export function calculateExpiryDate(expiresIn?: number): Date | null {
  if (!expiresIn || expiresIn <= 0) return null;
  return new Date(Date.now() + expiresIn * 1000);
}
