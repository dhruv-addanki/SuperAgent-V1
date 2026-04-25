import { describe, expect, it } from "vitest";
import { GoogleTokenService, hasRequiredScopes } from "../src/modules/google/tokenService";

describe("token service scope matching", () => {
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
    expect(hasRequiredScopes(granted, ["https://www.googleapis.com/auth/gmail.compose"])).toBe(
      true
    );
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
});
