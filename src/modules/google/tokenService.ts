import type { PrismaClient, User } from "@prisma/client";
import { env } from "../../config/env";
import { decryptString, encryptString } from "../../lib/crypto";
import { AuthRequiredError } from "../../lib/errors";

const { google } = require("googleapis") as any;

export class GoogleTokenService {
  constructor(private readonly prisma: PrismaClient) {}

  getConnectUrl(phone: string): string {
    const url = new URL("/auth/google/start", env.APP_BASE_URL);
    url.searchParams.set("phone", phone);
    return url.toString();
  }

  async getOAuthClientForUser(user: Pick<User, "id" | "whatsappPhone">): Promise<any> {
    const account = await this.prisma.googleAccount.findUnique({
      where: { userId: user.id }
    });

    if (!account) {
      throw new AuthRequiredError(this.getConnectUrl(user.whatsappPhone));
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
