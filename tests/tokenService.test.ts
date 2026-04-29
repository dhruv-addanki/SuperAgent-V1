import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptString } from "../src/lib/crypto";
import { GoogleTokenService, hasRequiredScopes } from "../src/modules/google/tokenService";

const googleMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  setCredentials: vi.fn(),
  credentials: {} as Record<string, unknown>
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: googleMocks.setCredentials,
        getAccessToken: googleMocks.getAccessToken,
        credentials: googleMocks.credentials
      }))
    }
  }
}));

describe("token service scope matching", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(googleMocks.credentials)) {
      delete googleMocks.credentials[key];
    }
  });

  it("treats broad Google scopes as satisfying narrower feature checks", () => {
    const granted = [
      "openid",
      "email",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive"
    ].join(" ");

    expect(
      hasRequiredScopes(granted, ["https://www.googleapis.com/auth/calendar.calendarlist.readonly"])
    ).toBe(true);
    expect(hasRequiredScopes(granted, ["https://www.googleapis.com/auth/calendar.events"])).toBe(
      true
    );
    expect(hasRequiredScopes(granted, ["https://www.googleapis.com/auth/drive"])).toBe(true);
    expect(
      hasRequiredScopes(granted, ["https://www.googleapis.com/auth/drive.metadata.readonly"])
    ).toBe(true);
    expect(hasRequiredScopes(granted, ["https://www.googleapis.com/auth/documents"])).toBe(true);
    expect(hasRequiredScopes(granted, ["https://www.googleapis.com/auth/gmail.readonly"])).toBe(
      true
    );
    expect(hasRequiredScopes(granted, ["https://www.googleapis.com/auth/gmail.compose"])).toBe(
      true
    );
    expect(hasRequiredScopes(granted, ["https://www.googleapis.com/auth/gmail.modify"])).toBe(true);
    expect(hasRequiredScopes(granted, ["https://www.googleapis.com/auth/gmail.send"])).toBe(true);
  });

  it("uses a short connect message when Google is missing", async () => {
    const service = new GoogleTokenService({
      googleAccount: {
        findUnique: async () => null
      }
    } as any);

    await expect(
      service.getOAuthClientForUser({ id: "user_1", whatsappPhone: "+15555550100" })
    ).rejects.toMatchObject({
      code: "GOOGLE_AUTH_REQUIRED",
      userMessage: expect.stringMatching(
        /^Connect Google first: .*\/auth\/google\/start\?phone=%2B15555550100$/
      )
    });
  });

  it("asks for Google reauth when refresh fails", async () => {
    const service = new GoogleTokenService({
      googleAccount: {
        findUnique: async () => ({
          accessToken: encryptString("old-access"),
          refreshToken: encryptString("old-refresh"),
          expiryDate: new Date(Date.now() - 60 * 1000),
          scope: "https://mail.google.com/"
        }),
        update: vi.fn()
      }
    } as any);

    googleMocks.getAccessToken.mockRejectedValueOnce(
      Object.assign(new Error("invalid_grant"), {
        response: {
          status: 400,
          data: {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked."
          }
        }
      })
    );

    await expect(
      service.getOAuthClientForUser(
        { id: "user_1", whatsappPhone: "+15555550100" },
        { reconnectReason: "Reconnect your Google account to read Gmail" }
      )
    ).rejects.toMatchObject({
      code: "GOOGLE_REAUTH_REQUIRED",
      userMessage: expect.stringMatching(
        /^Reconnect your Google account to read Gmail: .*\/auth\/google\/start\?phone=%2B15555550100$/
      )
    });
  });
});
