import type { PrismaClient, User } from "@prisma/client";
import { env } from "../../config/env";
import { decryptString, encryptString } from "../../lib/crypto";
import { AuthRequiredError, ReauthRequiredError } from "../../lib/errors";
import { calculateNotionExpiryDate, exchangeNotionToken } from "./notionOAuthClient";

export class NotionTokenService {
  constructor(private readonly prisma: PrismaClient) {}

  getConnectUrl(phone: string): string {
    const url = new URL("/auth/notion/start", env.APP_BASE_URL);
    url.searchParams.set("phone", phone);
    return url.toString();
  }

  async getAccessTokenForUser(user: Pick<User, "id" | "whatsappPhone">): Promise<string> {
    const account = await this.prisma.notionAccount.findUnique({
      where: { userId: user.id }
    });

    if (!account) {
      throw new AuthRequiredError(this.getConnectUrl(user.whatsappPhone), "Notion", "NOTION");
    }

    const expiresSoon =
      account.expiryDate && account.expiryDate.getTime() < Date.now() + 2 * 60_000;

    if (!expiresSoon) {
      return decryptString(account.accessToken);
    }

    if (!account.refreshToken) {
      throw new ReauthRequiredError(
        this.getConnectUrl(user.whatsappPhone),
        "Reconnect your Notion account to continue",
        "Notion",
        "NOTION"
      );
    }

    try {
      const refreshed = await exchangeNotionToken({
        grant_type: "refresh_token",
        refresh_token: decryptString(account.refreshToken)
      });

      if (!refreshed.access_token) {
        throw new Error("Missing refreshed Notion access token");
      }

      await this.prisma.notionAccount.update({
        where: { userId: user.id },
        data: {
          accessToken: encryptString(refreshed.access_token),
          refreshToken: refreshed.refresh_token
            ? encryptString(refreshed.refresh_token)
            : account.refreshToken,
          expiryDate: calculateNotionExpiryDate(refreshed.expires_in) ?? account.expiryDate,
          scope: refreshed.scope ?? account.scope
        }
      });

      return refreshed.access_token;
    } catch {
      throw new ReauthRequiredError(
        this.getConnectUrl(user.whatsappPhone),
        "Reconnect your Notion account to continue",
        "Notion",
        "NOTION"
      );
    }
  }

  async hasConnectedNotion(userId: string): Promise<boolean> {
    const count = await this.prisma.notionAccount.count({ where: { userId } });
    return count > 0;
  }
}
