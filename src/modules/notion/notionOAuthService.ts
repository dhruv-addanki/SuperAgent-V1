import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { encryptString } from "../../lib/crypto";
import {
  buildNotionAuthUrl,
  calculateNotionExpiryDate,
  exchangeNotionToken
} from "./notionOAuthClient";

interface OAuthState {
  phone: string;
  nonce: string;
  issuedAt: number;
}

export class NotionOAuthService {
  constructor(private readonly prisma: PrismaClient) {}

  getAuthUrl(phone: string): string {
    const state: OAuthState = {
      phone,
      nonce: crypto.randomUUID(),
      issuedAt: Date.now()
    };

    return buildNotionAuthUrl(Buffer.from(JSON.stringify(state), "utf8").toString("base64url"));
  }

  async handleCallback(
    code: string,
    rawState: string
  ): Promise<{ phone: string; workspaceName?: string | null }> {
    const state = this.parseState(rawState);
    const tokens = await exchangeNotionToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.NOTION_REDIRECT_URI
    });

    if (!tokens.access_token) {
      throw new Error("Notion OAuth did not return an access token");
    }

    const user = await this.prisma.user.upsert({
      where: { whatsappPhone: state.phone },
      update: {},
      create: {
        whatsappPhone: state.phone
      }
    });

    await this.prisma.notionAccount.upsert({
      where: { userId: user.id },
      update: {
        workspaceId: tokens.workspace_id ?? undefined,
        workspaceName: tokens.workspace_name ?? undefined,
        workspaceIcon: tokens.workspace_icon ?? undefined,
        botId: tokens.bot_id ?? undefined,
        ownerType: tokens.owner?.type ?? undefined,
        accessToken: encryptString(tokens.access_token),
        refreshToken: tokens.refresh_token ? encryptString(tokens.refresh_token) : undefined,
        expiryDate: calculateNotionExpiryDate(tokens.expires_in),
        scope: tokens.scope ?? ""
      },
      create: {
        userId: user.id,
        workspaceId: tokens.workspace_id ?? undefined,
        workspaceName: tokens.workspace_name ?? undefined,
        workspaceIcon: tokens.workspace_icon ?? undefined,
        botId: tokens.bot_id ?? undefined,
        ownerType: tokens.owner?.type ?? undefined,
        accessToken: encryptString(tokens.access_token),
        refreshToken: tokens.refresh_token ? encryptString(tokens.refresh_token) : undefined,
        expiryDate: calculateNotionExpiryDate(tokens.expires_in),
        scope: tokens.scope ?? ""
      }
    });

    return { phone: state.phone, workspaceName: tokens.workspace_name };
  }

  private parseState(rawState: string): OAuthState {
    const parsed = JSON.parse(Buffer.from(rawState, "base64url").toString("utf8")) as OAuthState;
    if (!parsed.phone || !parsed.nonce || !parsed.issuedAt) {
      throw new Error("Invalid OAuth state");
    }
    if (Date.now() - parsed.issuedAt > 15 * 60_000) {
      throw new Error("OAuth state expired");
    }
    return parsed;
  }
}
