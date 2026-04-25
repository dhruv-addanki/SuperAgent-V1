import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { GOOGLE_SCOPES } from "../../config/constants";
import { encryptString } from "../../lib/crypto";
import { LongTermMemory } from "../memory/longTermMemory";

const { google } = require("googleapis") as any;

interface OAuthState {
  phone: string;
  nonce: string;
  issuedAt: number;
}

export class GoogleOAuthService {
  constructor(private readonly prisma: PrismaClient) {}

  createOAuthClient(): any {
    return new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI
    );
  }

  getAuthUrl(phone: string): string {
    const state: OAuthState = {
      phone,
      nonce: crypto.randomUUID(),
      issuedAt: Date.now()
    };

    return this.createOAuthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: [...GOOGLE_SCOPES],
      state: Buffer.from(JSON.stringify(state), "utf8").toString("base64url")
    });
  }

  async handleCallback(code: string, rawState: string): Promise<{ email?: string; phone: string }> {
    const state = this.parseState(rawState);
    const oauthClient = this.createOAuthClient();
    const { tokens } = await oauthClient.getToken(code);

    if (!tokens.access_token) {
      throw new Error("Google OAuth did not return an access token");
    }

    if (!tokens.refresh_token) {
      throw new Error(
        "Google OAuth did not return a refresh token. Revoke the app and retry with prompt=consent."
      );
    }

    oauthClient.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauthClient });
    const { data: profile } = await oauth2.userinfo.get();

    const user = await this.prisma.user.upsert({
      where: { whatsappPhone: state.phone },
      update: { googleEmail: profile.email ?? undefined },
      create: {
        whatsappPhone: state.phone,
        googleEmail: profile.email ?? undefined
      }
    });

    await this.prisma.googleAccount.upsert({
      where: { userId: user.id },
      update: {
        accessToken: encryptString(tokens.access_token),
        refreshToken: encryptString(tokens.refresh_token),
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scope: tokens.scope ?? GOOGLE_SCOPES.join(" ")
      },
      create: {
        userId: user.id,
        accessToken: encryptString(tokens.access_token),
        refreshToken: encryptString(tokens.refresh_token),
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scope: tokens.scope ?? GOOGLE_SCOPES.join(" ")
      }
    });

    await new LongTermMemory(this.prisma).rememberNameCandidate(
      user.id,
      typeof profile.name === "string" ? profile.name : undefined,
      "google"
    );

    return { email: profile.email ?? undefined, phone: state.phone };
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
