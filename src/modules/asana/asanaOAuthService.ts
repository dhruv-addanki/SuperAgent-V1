import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ASANA_SCOPES } from "../../config/constants";
import { env } from "../../config/env";
import { encryptString } from "../../lib/crypto";
import { LongTermMemory } from "../memory/longTermMemory";
import {
  buildAsanaAuthUrl,
  calculateExpiryDate,
  exchangeAsanaToken
} from "./asanaOAuthClient";

interface OAuthState {
  phone: string;
  nonce: string;
  issuedAt: number;
}

export class AsanaOAuthService {
  constructor(private readonly prisma: PrismaClient) {}

  getAuthUrl(phone: string): string {
    const state: OAuthState = {
      phone,
      nonce: crypto.randomUUID(),
      issuedAt: Date.now()
    };

    return buildAsanaAuthUrl(
      Buffer.from(JSON.stringify(state), "utf8").toString("base64url"),
      ASANA_SCOPES
    );
  }

  async handleCallback(
    code: string,
    rawState: string
  ): Promise<{ email?: string; name?: string; phone: string }> {
    const state = this.parseState(rawState);
    const tokens = await exchangeAsanaToken({
      grant_type: "authorization_code",
      client_id: env.ASANA_CLIENT_ID,
      client_secret: env.ASANA_CLIENT_SECRET,
      redirect_uri: env.ASANA_REDIRECT_URI,
      code
    });

    if (!tokens.access_token) {
      throw new Error("Asana OAuth did not return an access token");
    }

    if (!tokens.refresh_token) {
      throw new Error("Asana OAuth did not return a refresh token");
    }

    if (!tokens.data?.gid) {
      throw new Error("Asana OAuth did not return the connected user ID");
    }

    const user = await this.prisma.user.upsert({
      where: { whatsappPhone: state.phone },
      update: {},
      create: {
        whatsappPhone: state.phone
      }
    });

    await this.prisma.asanaAccount.upsert({
      where: { userId: user.id },
      update: {
        asanaUserGid: tokens.data.gid,
        asanaEmail: tokens.data?.email ?? undefined,
        asanaName: tokens.data?.name ?? undefined,
        accessToken: encryptString(tokens.access_token),
        refreshToken: encryptString(tokens.refresh_token),
        expiryDate: calculateExpiryDate(tokens.expires_in),
        scope: tokens.scope ?? ASANA_SCOPES.join(" ")
      },
      create: {
        userId: user.id,
        asanaUserGid: tokens.data.gid,
        asanaEmail: tokens.data?.email ?? undefined,
        asanaName: tokens.data?.name ?? undefined,
        accessToken: encryptString(tokens.access_token),
        refreshToken: encryptString(tokens.refresh_token),
        expiryDate: calculateExpiryDate(tokens.expires_in),
        scope: tokens.scope ?? ASANA_SCOPES.join(" ")
      }
    });

    await new LongTermMemory(this.prisma).rememberNameCandidate(
      user.id,
      tokens.data?.name,
      "asana"
    );

    return {
      email: tokens.data?.email ?? undefined,
      name: tokens.data?.name ?? undefined,
      phone: state.phone
    };
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
