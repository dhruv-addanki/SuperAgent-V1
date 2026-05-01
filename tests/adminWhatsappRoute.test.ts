import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAdminWhatsAppRoutes } from "../src/routes/adminWhatsapp";

describe("admin WhatsApp routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
    vi.clearAllMocks();
  });

  it("rejects missing and invalid admin tokens", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const service = { submit: vi.fn() };
    await registerAdminWhatsAppRoutes(app, { service: service as any });

    const missing = await app.inject({
      method: "POST",
      url: "/admin/whatsapp/outbound",
      payload: { phone: "+17035974755", mode: "exact", message: "Hi" }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/admin/whatsapp/outbound",
      headers: { authorization: "Bearer wrong" },
      payload: { phone: "+17035974755", mode: "exact", message: "Hi" }
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("accepts valid admin token and returns pending drafts with 202", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const service = {
      submit: vi.fn(async () => ({
        status: "pending",
        mode: "draft",
        phone: "+17035974755",
        preview: "Draft",
        approvalCode: "approval_1",
        expiresAt: new Date("2026-04-30T12:30:00.000Z")
      }))
    };
    await registerAdminWhatsAppRoutes(app, { service: service as any });

    const response = await app.inject({
      method: "POST",
      url: "/admin/whatsapp/outbound",
      headers: { authorization: "Bearer test-admin-token" },
      payload: {
        phone: "+17035974755",
        mode: "draft",
        instruction: "Draft a short note"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(service.submit).toHaveBeenCalledWith({
      phone: "+17035974755",
      mode: "draft",
      instruction: "Draft a short note"
    });
    expect(response.json()).toMatchObject({
      status: "pending",
      approvalCode: "approval_1",
      preview: "Draft"
    });
  });

  it("confirms pending outbound messages through the protected route", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const service = {
      confirm: vi.fn(async () => ({
        status: "sent",
        mode: "confirmed",
        phone: "+17035974755",
        message: "Preview",
        delivery: { channel: "text", messageId: "wamid.confirmed" }
      }))
    };
    await registerAdminWhatsAppRoutes(app, { service: service as any });

    const response = await app.inject({
      method: "POST",
      url: "/admin/whatsapp/outbound/confirm",
      headers: { authorization: "Bearer test-admin-token" },
      payload: { approvalCode: "approval_1" }
    });

    expect(response.statusCode).toBe(200);
    expect(service.confirm).toHaveBeenCalledWith({ approvalCode: "approval_1" });
    expect(response.json()).toMatchObject({
      status: "sent",
      delivery: { channel: "text", messageId: "wamid.confirmed" }
    });
  });
});
