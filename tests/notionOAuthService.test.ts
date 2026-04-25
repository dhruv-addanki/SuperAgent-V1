import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptString } from "../src/lib/crypto";
import { NotionOAuthService } from "../src/modules/notion/notionOAuthService";

describe("Notion OAuth service", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a Notion OAuth URL with encoded phone state", () => {
    const service = new NotionOAuthService({} as any);
    const url = new URL(service.getAuthUrl("+15555550100"));

    expect(url.origin).toBe("https://api.notion.com");
    expect(url.pathname).toBe("/v1/oauth/authorize");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("response_type")).toBe("code");

    const rawState = url.searchParams.get("state");
    expect(rawState).toBeTruthy();
    const state = JSON.parse(Buffer.from(rawState!, "base64url").toString("utf8"));
    expect(state.phone).toBe("+15555550100");
  });

  it("exchanges a callback code and stores encrypted workspace tokens", async () => {
    const userUpsert = vi.fn(async () => ({ id: "user_1" }));
    const notionUpsert = vi.fn(async () => undefined);
    const service = new NotionOAuthService({
      user: { upsert: userUpsert },
      notionAccount: { upsert: notionUpsert }
    } as any);
    const state = Buffer.from(
      JSON.stringify({
        phone: "+15555550100",
        nonce: "nonce",
        issuedAt: Date.now()
      }),
      "utf8"
    ).toString("base64url");

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "notion-access",
        refresh_token: "notion-refresh",
        expires_in: 3600,
        workspace_id: "workspace_1",
        workspace_name: "Dhruv HQ",
        workspace_icon: "https://example.com/icon.png",
        bot_id: "bot_1",
        owner: { type: "user" },
        scope: "read_content insert_content"
      })
    });

    const result = await service.handleCallback("code_123", state);

    expect(result).toEqual({
      phone: "+15555550100",
      workspaceName: "Dhruv HQ"
    });
    expect(userUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { whatsappPhone: "+15555550100" }
      })
    );
    expect(notionUpsert).toHaveBeenCalledOnce();
    const data = notionUpsert.mock.calls[0][0].create;
    expect(data.workspaceId).toBe("workspace_1");
    expect(data.workspaceName).toBe("Dhruv HQ");
    expect(data.botId).toBe("bot_1");
    expect(decryptString(data.accessToken)).toBe("notion-access");
    expect(decryptString(data.refreshToken)).toBe("notion-refresh");
  });
});
