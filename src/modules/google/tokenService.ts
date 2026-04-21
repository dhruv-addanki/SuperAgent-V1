import type { PrismaClient, User } from "@prisma/client";
import { env } from "../../config/env";
import { decryptString, encryptString } from "../../lib/crypto";
import { AuthRequiredError, ReauthRequiredError } from "../../lib/errors";

const { google } = require("googleapis") as any;

const IMPLIED_SCOPES: Record<string, string[]> = {
  "https://mail.google.com/": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.metadata"
  ],
  "https://www.googleapis.com/auth/calendar": [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.freebusy"
  ],
  "https://www.googleapis.com/auth/drive": [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/documents.readonly"
  ]
};

export class GoogleTokenService {
  constructor(private readonly prisma: PrismaClient) {}

  getConnectUrl(phone: string): string {
    const url = new URL("/auth/google/start", env.APP_BASE_URL);
    url.searchParams.set("phone", phone);
    return url.toString();
  }

  async getOAuthClientForUser(
    user: Pick<User, "id" | "whatsappPhone">,
    options: { requiredScopes?: string[]; reconnectReason?: string } = {}
  ): Promise<any> {
    const account = await this.prisma.googleAccount.findUnique({
      where: { userId: user.id }
    });

    if (!account) {
      throw new AuthRequiredError(this.getConnectUrl(user.whatsappPhone));
    }

    if (
      options.requiredScopes?.length &&
      !hasRequiredScopes(account.scope, options.requiredScopes)
    ) {
      throw new ReauthRequiredError(
        this.getConnectUrl(user.whatsappPhone),
        options.reconnectReason ?? "Reconnect your Google account to grant additional access"
      );
    }

    const oauthClient = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI
    );

    oauthClient.setCredentials({
      access_token: decryptString(account.accessToken),
      refresh_token: decryptString(account.refreshToken),
      expiry_date: account.expiryDate?.getTime()
    });

    const expiresSoon =
      !account.expiryDate || account.expiryDate.getTime() < Date.now() + 2 * 60_000;

    if (expiresSoon) {
      await oauthClient.getAccessToken();
      const credentials = oauthClient.credentials;
      if (credentials.access_token || credentials.expiry_date) {
        await this.prisma.googleAccount.update({
          where: { userId: user.id },
          data: {
            accessToken: credentials.access_token
              ? encryptString(credentials.access_token)
              : account.accessToken,
            refreshToken: credentials.refresh_token
              ? encryptString(credentials.refresh_token)
              : account.refreshToken,
            expiryDate: credentials.expiry_date
              ? new Date(credentials.expiry_date)
              : account.expiryDate
          }
        });
      }
    }

    return oauthClient;
  }

  async hasConnectedGoogle(userId: string): Promise<boolean> {
    const count = await this.prisma.googleAccount.count({ where: { userId } });
    return count > 0;
  }
}

export function hasRequiredScopes(grantedScopes: string, requiredScopes: string[]): boolean {
  const granted = expandGrantedScopes(grantedScopes);
  return requiredScopes.every((scope) => granted.has(scope));
}

function expandGrantedScopes(grantedScopes: string): Set<string> {
  const granted = new Set(grantedScopes.split(/\s+/).filter(Boolean));

  for (const scope of [...granted]) {
    for (const implied of IMPLIED_SCOPES[scope] ?? []) {
      granted.add(implied);
    }
  }

  return granted;
}
