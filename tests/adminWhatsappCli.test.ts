import { describe, expect, it } from "vitest";
import { parseAdminWhatsappArgs } from "../src/scripts/adminWhatsapp";

describe("admin WhatsApp CLI", () => {
  const env = {
    ADMIN_API_TOKEN: "token",
    APP_BASE_URL: "https://agent.example.com/"
  };

  it("parses exact sends", () => {
    expect(parseAdminWhatsappArgs(["--phone", "+17035974755", "--exact", "Hello"], env)).toEqual({
      baseUrl: "https://agent.example.com",
      token: "token",
      endpoint: "/admin/whatsapp/outbound",
      body: {
        phone: "+17035974755",
        mode: "exact",
        message: "Hello"
      }
    });
  });

  it("parses prompted drafts", () => {
    expect(
      parseAdminWhatsappArgs(["--phone", "+17035974755", "--prompt", "Draft a note"], env)
    ).toMatchObject({
      endpoint: "/admin/whatsapp/outbound",
      body: {
        phone: "+17035974755",
        mode: "draft",
        instruction: "Draft a note"
      }
    });
  });

  it("parses confirmations", () => {
    expect(parseAdminWhatsappArgs(["--confirm", "approval_1"], env)).toMatchObject({
      endpoint: "/admin/whatsapp/outbound/confirm",
      body: { approvalCode: "approval_1" }
    });
  });

  it("parses cancellations", () => {
    expect(parseAdminWhatsappArgs(["--cancel", "approval_1"], env)).toMatchObject({
      endpoint: "/admin/whatsapp/outbound/cancel",
      body: { approvalCode: "approval_1" }
    });
  });

  it("requires a phone for send requests", () => {
    expect(() => parseAdminWhatsappArgs(["--exact", "Hello"], env)).toThrow("Missing --phone.");
  });

  it("requires an admin token", () => {
    expect(() =>
      parseAdminWhatsappArgs(["--confirm", "approval_1"], { APP_BASE_URL: "https://x.test" })
    ).toThrow("Missing ADMIN_API_TOKEN");
  });
});
