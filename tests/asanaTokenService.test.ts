import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptString, encryptString } from "../src/lib/crypto";
import { AsanaTokenService } from "../src/modules/asana/tokenService";

describe("asana token service", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires a connected Asana account", async () => {
    const service = new AsanaTokenService({
      asanaAccount: {
        findUnique: vi.fn(async () => null)
      }
    } as any);

    await expect(
      service.getAccessTokenForUser({ id: "user_1", whatsappPhone: "+15555550100" } as any)
    ).rejects.toMatchObject({
      code: "ASANA_AUTH_REQUIRED",
      userMessage: expect.stringMatching(
        /^Connect Asana first: .*\/auth\/asana\/start\?phone=%2B15555550100$/
      )
    });
  });

  it("requires reauth when scopes are missing", async () => {
    const service = new AsanaTokenService({
      asanaAccount: {
        findUnique: vi.fn(async () => ({
          accessToken: encryptString("access-token"),
          refreshToken: encryptString("refresh-token"),
          scope: "tasks:read",
          expiryDate: new Date(Date.now() + 60 * 60 * 1000)
        }))
      }
    } as any);

    await expect(
      service.getAccessTokenForUser(
        { id: "user_1", whatsappPhone: "+15555550100" } as any,
        { requiredScopes: ["tasks:write"] }
      )
    ).rejects.toMatchObject({
      code: "ASANA_REAUTH_REQUIRED"
    });
  });

  it("returns the stored token when it is not close to expiry", async () => {
    const service = new AsanaTokenService({
      asanaAccount: {
        findUnique: vi.fn(async () => ({
          accessToken: encryptString("stored-access"),
          refreshToken: encryptString("refresh-token"),
          scope: "tasks:read tasks:write",
          expiryDate: new Date(Date.now() + 60 * 60 * 1000)
        }))
      }
    } as any);

    const token = await service.getAccessTokenForUser({
      id: "user_1",
      whatsappPhone: "+15555550100"
    } as any);

    expect(token).toBe("stored-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes expired tokens and persists the new values", async () => {
    const update = vi.fn(async () => undefined);
    const service = new AsanaTokenService({
      asanaAccount: {
        findUnique: vi.fn(async () => ({
          accessToken: encryptString("old-access"),
          refreshToken: encryptString("old-refresh"),
          scope: "tasks:read tasks:write",
          expiryDate: new Date(Date.now() - 60 * 1000)
        })),
        update
      }
    } as any);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "tasks:read tasks:write"
      })
    });

    const token = await service.getAccessTokenForUser({
      id: "user_1",
      whatsappPhone: "+15555550100"
    } as any);

    expect(token).toBe("new-access");
    expect(update).toHaveBeenCalledOnce();
    expect(decryptString(update.mock.calls[0][0].data.accessToken)).toBe("new-access");
  });

  it("asks for reauth when refresh fails", async () => {
    const service = new AsanaTokenService({
      asanaAccount: {
        findUnique: vi.fn(async () => ({
          accessToken: encryptString("old-access"),
          refreshToken: encryptString("old-refresh"),
          scope: "tasks:read tasks:write",
          expiryDate: new Date(Date.now() - 60 * 1000)
        })),
        update: vi.fn()
      }
    } as any);

    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "invalid_grant"
      })
    });

    await expect(
      service.getAccessTokenForUser({ id: "user_1", whatsappPhone: "+15555550100" } as any)
    ).rejects.toMatchObject({
      code: "ASANA_REAUTH_REQUIRED"
    });
  });
});
