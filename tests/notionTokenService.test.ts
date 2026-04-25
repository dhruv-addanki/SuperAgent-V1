import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptString, encryptString } from "../src/lib/crypto";
import { NotionTokenService } from "../src/modules/notion/tokenService";

describe("Notion token service", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires a connected Notion account", async () => {
    const service = new NotionTokenService({
      notionAccount: {
        findUnique: vi.fn(async () => null)
      }
    } as any);

    await expect(
      service.getAccessTokenForUser({ id: "user_1", whatsappPhone: "+15555550100" } as any)
    ).rejects.toMatchObject({
      code: "NOTION_AUTH_REQUIRED"
    });
  });

  it("returns a stored token when there is no expiry", async () => {
    const service = new NotionTokenService({
      notionAccount: {
        findUnique: vi.fn(async () => ({
          accessToken: encryptString("stored-access"),
          refreshToken: null,
          expiryDate: null
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

  it("refreshes expiring tokens when a refresh token is available", async () => {
    const update = vi.fn(async () => undefined);
    const service = new NotionTokenService({
      notionAccount: {
        findUnique: vi.fn(async () => ({
          accessToken: encryptString("old-access"),
          refreshToken: encryptString("old-refresh"),
          scope: "read_content",
          expiryDate: new Date(Date.now() + 10 * 1000)
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
        scope: "read_content insert_content"
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
});
