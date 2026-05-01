import { MessageRole, PendingActionStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminWhatsAppOutboundService } from "../src/modules/admin/adminWhatsappOutboundService";

describe("admin WhatsApp outbound service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends exact messages immediately without calling the model", async () => {
    const prisma = basePrisma({ recentInbound: true });
    const responsesClient = { createResponse: vi.fn() };
    const whatsappService = {
      sendTextMessage: vi.fn(async () => ({ messageId: "wamid.text" })),
      sendTemplateMessage: vi.fn()
    };
    const service = new AdminWhatsAppOutboundService(
      prisma as any,
      responsesClient as any,
      whatsappService as any,
      { now: fixedNow }
    );

    const result = await service.submit({
      phone: "17035974755",
      mode: "exact",
      message: "Exact hello"
    });

    expect(result).toMatchObject({
      status: "sent",
      mode: "exact",
      phone: "+17035974755",
      message: "Exact hello",
      delivery: { channel: "text", messageId: "wamid.text" }
    });
    expect(responsesClient.createResponse).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith("+17035974755", "Exact hello");
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conversation_1",
          role: MessageRole.ASSISTANT,
          content: "Exact hello"
        })
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "admin_whatsapp_outbound_exact",
          status: "executed"
        })
      })
    );
  });

  it("auto mode sends exactly only when the request clearly says exact", async () => {
    const prisma = basePrisma({ recentInbound: true });
    const responsesClient = { createResponse: vi.fn() };
    const whatsappService = {
      sendTextMessage: vi.fn(async () => ({ messageId: "wamid.auto" })),
      sendTemplateMessage: vi.fn()
    };
    const service = new AdminWhatsAppOutboundService(
      prisma as any,
      responsesClient as any,
      whatsappService as any,
      { now: fixedNow }
    );

    await service.submit({
      phone: "+17035974755",
      mode: "auto",
      request: "send exactly this: reconnect complete"
    });

    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "+17035974755",
      "reconnect complete"
    );
    expect(responsesClient.createResponse).not.toHaveBeenCalled();
  });

  it("auto mode without exact wording stages a draft and does not send WhatsApp", async () => {
    const prisma = basePrisma({ recentInbound: true });
    const responsesClient = {
      createResponse: vi.fn(async () => ({ output_text: "Drafted note" }))
    };
    const whatsappService = {
      sendTextMessage: vi.fn(),
      sendTemplateMessage: vi.fn()
    };
    const service = new AdminWhatsAppOutboundService(
      prisma as any,
      responsesClient as any,
      whatsappService as any,
      { now: fixedNow }
    );

    const result = await service.submit({
      phone: "+17035974755",
      mode: "auto",
      request: "tell him the reconnect is done"
    });

    expect(result).toMatchObject({
      status: "pending",
      mode: "draft",
      phone: "+17035974755",
      preview: "Drafted note",
      approvalCode: "approval_1"
    });
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalled();
    expect(prisma.pendingAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "admin_whatsapp_outbound",
          payload: expect.objectContaining({
            kind: "admin_whatsapp_outbound",
            phone: "+17035974755",
            message: "Drafted note"
          })
        })
      })
    );
  });

  it("does not silently draft when exact mode has no message body", async () => {
    const service = new AdminWhatsAppOutboundService(
      basePrisma({ recentInbound: true }) as any,
      { createResponse: vi.fn() } as any,
      {
        sendTextMessage: vi.fn(),
        sendTemplateMessage: vi.fn()
      } as any,
      { now: fixedNow }
    );

    await expect(
      service.submit({
        phone: "+17035974755",
        mode: "exact",
        request: "send something"
      })
    ).rejects.toMatchObject({ code: "ADMIN_OUTBOUND_MISSING_MESSAGE" });
  });

  it("confirms a staged draft by sending only the preview body", async () => {
    const prisma = basePrisma({
      recentInbound: true,
      pendingAction: pendingAction({
        payload: {
          kind: "admin_whatsapp_outbound",
          phone: "+17035974755",
          message: "Preview body",
          instruction: "Draft something",
          createdAt: fixedNow().toISOString()
        }
      })
    });
    const whatsappService = {
      sendTextMessage: vi.fn(async () => ({ messageId: "wamid.confirmed" })),
      sendTemplateMessage: vi.fn()
    };
    const service = new AdminWhatsAppOutboundService(
      prisma as any,
      { createResponse: vi.fn() } as any,
      whatsappService as any,
      { now: fixedNow }
    );

    const result = await service.confirm({ approvalCode: "approval_1" });

    expect(result).toMatchObject({
      status: "sent",
      mode: "confirmed",
      message: "Preview body",
      delivery: { channel: "text", messageId: "wamid.confirmed" }
    });
    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith("+17035974755", "Preview body");
    expect(prisma.pendingAction.update).toHaveBeenCalledWith({
      where: { id: "pending_1" },
      data: { status: PendingActionStatus.APPROVED }
    });
    expect(prisma.pendingAction.update).toHaveBeenCalledWith({
      where: { id: "pending_1" },
      data: { status: PendingActionStatus.EXECUTED }
    });
  });

  it("fails safely for missing, expired, cancelled, and already-used confirmations", async () => {
    await expect(
      new AdminWhatsAppOutboundService(
        basePrisma({ pendingAction: null }) as any,
        { createResponse: vi.fn() } as any,
        {} as any,
        { now: fixedNow }
      ).confirm({ approvalCode: "missing" })
    ).rejects.toMatchObject({ code: "ADMIN_OUTBOUND_NOT_FOUND" });

    await expect(
      new AdminWhatsAppOutboundService(
        basePrisma({
          pendingAction: pendingAction({ expiresAt: new Date("2026-04-29T12:00:00.000Z") })
        }) as any,
        { createResponse: vi.fn() } as any,
        {} as any,
        { now: fixedNow }
      ).confirm({ approvalCode: "expired" })
    ).rejects.toMatchObject({ code: "ADMIN_OUTBOUND_EXPIRED" });

    for (const status of [PendingActionStatus.CANCELLED, PendingActionStatus.EXECUTED]) {
      await expect(
        new AdminWhatsAppOutboundService(
          basePrisma({ pendingAction: pendingAction({ status }) }) as any,
          { createResponse: vi.fn() } as any,
          {} as any,
          { now: fixedNow }
        ).confirm({ approvalCode: status })
      ).rejects.toMatchObject({ code: "ADMIN_OUTBOUND_NOT_PENDING" });
    }
  });

  it("uses template delivery outside the 24-hour WhatsApp session window", async () => {
    const prisma = basePrisma({ recentInbound: false });
    const whatsappService = {
      sendTextMessage: vi.fn(),
      sendTemplateMessage: vi.fn(async () => ({ messageId: "wamid.template" }))
    };
    const service = new AdminWhatsAppOutboundService(
      prisma as any,
      { createResponse: vi.fn() } as any,
      whatsappService as any,
      {
        now: fixedNow,
        templateName: "admin_outbound",
        templateLanguage: "en_US"
      }
    );

    const result = await service.submit({
      phone: "+17035974755",
      mode: "exact",
      message: "Outside window"
    });

    expect(result).toMatchObject({
      status: "sent",
      delivery: { channel: "template", messageId: "wamid.template" }
    });
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalled();
    expect(whatsappService.sendTemplateMessage).toHaveBeenCalledWith({
      to: "+17035974755",
      templateName: "admin_outbound",
      languageCode: "en_US",
      bodyParameters: ["Outside window"]
    });
  });

  it("returns a template-required error outside the 24-hour window when no template is configured", async () => {
    const service = new AdminWhatsAppOutboundService(
      basePrisma({ recentInbound: false }) as any,
      { createResponse: vi.fn() } as any,
      {
        sendTextMessage: vi.fn(),
        sendTemplateMessage: vi.fn()
      } as any,
      {
        now: fixedNow,
        templateName: ""
      }
    );

    await expect(
      service.submit({
        phone: "+17035974755",
        mode: "exact",
        message: "Outside window"
      })
    ).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_REQUIRED" });
  });
});

function fixedNow(): Date {
  return new Date("2026-04-30T12:00:00.000Z");
}

function pendingAction(overrides: Record<string, unknown> = {}) {
  return {
    id: "pending_1",
    userId: "user_1",
    conversationId: "conversation_1",
    actionType: "admin_whatsapp_outbound",
    status: PendingActionStatus.PENDING,
    payload: {
      kind: "admin_whatsapp_outbound",
      phone: "+17035974755",
      message: "Preview body",
      instruction: "Draft something",
      createdAt: fixedNow().toISOString()
    },
    approvalCode: "approval_1",
    expiresAt: new Date("2026-04-30T12:30:00.000Z"),
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
    ...overrides
  };
}

function basePrisma(input: { recentInbound?: boolean; pendingAction?: any } = {}) {
  return {
    user: {
      upsert: vi.fn(async () => ({
        id: "user_1",
        whatsappPhone: "+17035974755",
        timezone: "America/New_York",
        createdAt: fixedNow(),
        updatedAt: fixedNow()
      }))
    },
    conversation: {
      findFirst: vi.fn(async () => ({
        id: "conversation_1",
        userId: "user_1"
      })),
      update: vi.fn(async () => undefined)
    },
    message: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () =>
        input.recentInbound
          ? {
              id: "message_1",
              role: MessageRole.USER,
              createdAt: fixedNow()
            }
          : null
      ),
      create: vi.fn(async () => undefined)
    },
    memoryEntry: {
      findMany: vi.fn(async () => [])
    },
    pendingAction: {
      create: vi.fn(async (args) => ({
        id: "pending_1",
        approvalCode: "approval_1",
        expiresAt: args.data.expiresAt
      })),
      findUnique: vi.fn(async () =>
        input.pendingAction === undefined ? pendingAction() : input.pendingAction
      ),
      update: vi.fn(async () => undefined)
    },
    auditLog: {
      create: vi.fn(async () => undefined)
    }
  };
}
