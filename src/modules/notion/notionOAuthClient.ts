import { env } from "../../config/env";

export const NOTION_API_BASE_URL = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2026-03-11";

export interface NotionTokenResponse {
  access_token?: string;
  token_type?: string;
  bot_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  workspace_id?: string | null;
  owner?: {
    type?: string;
  } | null;
  refresh_token?: string | null;
  expires_in?: number | null;
  scope?: string | null;
}

interface ExchangeNotionTokenInput {
  grant_type: "authorization_code" | "refresh_token";
  code?: string;
  refresh_token?: string;
  redirect_uri?: string;
}

export function buildNotionAuthUrl(state: string): string {
  const url = new URL(`${NOTION_API_BASE_URL}/oauth/authorize`);
  url.searchParams.set("client_id", env.NOTION_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", env.NOTION_REDIRECT_URI);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeNotionToken(
  input: ExchangeNotionTokenInput
): Promise<NotionTokenResponse> {
  const response = await fetch(`${NOTION_API_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`
      ).toString("base64")}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Notion OAuth token exchange failed: ${detail}`);
  }

  return (await response.json()) as NotionTokenResponse;
}

export function calculateNotionExpiryDate(expiresIn?: number | null): Date | null {
  return expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
}
