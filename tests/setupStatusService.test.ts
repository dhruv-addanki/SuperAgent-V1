import { describe, expect, it, vi } from "vitest";
import {
  formatSetupStatusForWhatsApp,
  SetupStatusService,
  setupStatusProfileLines
} from "../src/modules/agent/setupStatusService";

describe("setup status service", () => {
  it("returns connect links for missing integrations", async () => {
    const service = new SetupStatusService({
      googleAccount: { findUnique: vi.fn(async () => null) },
      asanaAccount: { findUnique: vi.fn(async () => null) },
      notionAccount: { findUnique: vi.fn(async () => null) }
    } as any);

    const status = await service.getStatus({
      id: "user_1",
      whatsappPhone: "+15555550100",
      googleEmail: null
    });

    expect(status.hasAnyConnected).toBe(false);
    expect(status.integrations.map((integration) => integration.connectUrl)).toEqual([
      expect.stringContaining("/auth/google/start?phone=%2B15555550100"),
      expect.stringContaining("/auth/asana/start?phone=%2B15555550100"),
      expect.stringContaining("/auth/notion/start?phone=%2B15555550100")
    ]);
    expect(formatSetupStatusForWhatsApp(status)).toContain(
      "Google powers Calendar, Gmail, Drive, and Docs."
    );
  });

  it("shows connected account labels and omits connect prompts for connected integrations", async () => {
    const service = new SetupStatusService({
      googleAccount: { findUnique: vi.fn(async () => ({ userId: "user_1" })) },
      asanaAccount: {
        findUnique: vi.fn(async () => ({
          asanaName: "Dhruv Addanki",
          asanaEmail: "dhruv@example.com"
        }))
      },
      notionAccount: {
        findUnique: vi.fn(async () => ({
          workspaceName: "Dhruv HQ"
        }))
      }
    } as any);

    const status = await service.getStatus({
      id: "user_1",
      whatsappPhone: "+15555550100",
      googleEmail: "dhruv@gmail.com"
    });

    const formatted = formatSetupStatusForWhatsApp(status);
    expect(status.allConnected).toBe(true);
    expect(formatted).toContain("- Google: connected (dhruv@gmail.com)");
    expect(formatted).toContain("- Asana: connected (Dhruv Addanki)");
    expect(formatted).toContain("- Notion: connected (Dhruv HQ)");
    expect(formatted).not.toContain("Connect:");
    expect(setupStatusProfileLines(status, "America/New_York")).toContain(
      "Connected integrations: Google (dhruv@gmail.com), Asana (Dhruv Addanki), Notion (Dhruv HQ)"
    );
  });
});
