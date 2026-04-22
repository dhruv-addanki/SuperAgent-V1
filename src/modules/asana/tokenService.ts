import type { PrismaClient, User } from "@prisma/client";
import { env } from "../../config/env";
import { decryptString, encryptString } from "../../lib/crypto";
import { AuthRequiredError, ReauthRequiredError } from "../../lib/errors";
import { calculateExpiryDate, exchangeAsanaToken } from "./asanaOAuthClient";

export class AsanaTokenService {
  constructor(private readonly prisma: PrismaClient) {}

  getConnectUrl(phone: string): string {
    const url = new URL("/auth/asana/start", env.APP_BASE_URL);
    url.searchParams.set("phone", phone);
    return url.toString();
  }

  async getAccessTokenForUser(
    user: Pick<User, "id" | "whatsappPhone">,
    options: { requiredScopes?: string[]; reconnectReason?: string } = {}
  ): Promise<string> {
    const account = await this.prisma.asanaAccount.findUnique({
      where: { userId: user.id }
    });

    if (!account) {
      throw new AuthRequiredError(this.getConnectUrl(user.whatsappPhone), "Asana", "ASANA");
    }

    if (options.requiredScopes?.length && !hasRequiredScopes(account.scope, options.requiredScopes)) {
      throw new ReauthRequiredError(
        this.getConnectUrl(user.whatsappPhone),
        options.reconnectReason ?? "Reconnect your Asana account to grant additional access",
        "Asana",
        "ASANA"
      );
    }

    const expiresSoon =
      !account.expiryDate || account.expiryDate.getTime() < Date.now() + 2 * 60_000;

    if (!expiresSoon) {
      return decryptString(account.accessToken);
    }

    try {
      const refreshed = await exchangeAsanaToken({
        grant_type: "refresh_token",
        refresh_token: decryptString(account.refreshToken),
        client_id: env.ASANA_CLIENT_ID,
        client_secret: env.ASANA_CLIENT_SECRET,
        redirect_uri: env.ASANA_REDIRECT_URI
      });

      if (!refreshed.access_token) {
        throw new Error("Missing refreshed access token");
      }

      await this.prisma.asanaAccount.update({
        where: { userId: user.id },
        data: {
          accessToken: encryptString(refreshed.access_token),
          refreshToken: refreshed.refresh_token
            ? encryptString(refreshed.refresh_token)
            : account.refreshToken,
          expiryDate: calculateExpiryDate(refreshed.expires_in) ?? account.expiryDate,
          scope: refreshed.scope ?? account.scope
        }
      });

      return refreshed.access_token;
    } catch {
      throw new ReauthRequiredError(
        this.getConnectUrl(user.whatsappPhone),
        options.reconnectReason ?? "Reconnect your Asana account to continue",
        "Asana",
        "ASANA"
      );
    }
  }

  async hasConnectedAsana(userId: string): Promise<boolean> {
    const count = await this.prisma.asanaAccount.count({ where: { userId } });
    return count > 0;
  }
}

export function hasRequiredScopes(grantedScopes: string, requiredScopes: string[]): boolean {
  const granted = new Set(grantedScopes.split(/\s+/).filter(Boolean));
  return requiredScopes.every((scope) => granted.has(scope));
}
