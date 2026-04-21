import { describe, expect, it, vi, beforeEach } from "vitest";

const createDraftMock = vi.fn();

vi.mock("../src/modules/google/gmailService", () => ({
  GmailService: vi.fn().mockImplementation(() => ({
    createDraft: createDraftMock
  }))
}));

import { ToolExecutor } from "../src/modules/agent/toolExecutor";

describe("tool executor email draft flow", () => {
  beforeEach(() => {
    createDraftMock.mockReset();
    createDraftMock.mockResolvedValue({
      draftId: "draft_123",
      messageId: "msg_123",
      to: "brad@example.com",
      subject: "Meeting",
      summary: "Draft to brad@example.com: Meeting"
    });
  });

  it("stages a pending send for draft-only requests without forcing approval immediately", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      pendingAction: { create: vi.fn(async () => ({ id: "pending_1" })) }
    } as any;

    const tokenService = {
      getOAuthClientForUser: vi.fn(async () => ({}))
    } as any;

    const executor = new ToolExecutor(prisma, tokenService);

    const result = await executor.executeToolCall(
      "gmail_create_draft",
      { to: "brad@example.com", subject: "Meeting", body: "Thursday works." },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "draft an email to Brad saying Thursday works"
      }
    );

    expect(result.ok).toBe(true);
    expect(result.approvalRequired).not.toBe(true);
    expect(result.userMessage).toBe("Draft ready. Want me to send it?");
    expect(prisma.pendingAction.create).toHaveBeenCalledOnce();
  });

  it("does not stage a pending send for explicit send requests", async () => {
    const prisma = {
      auditLog: { create: vi.fn(async () => undefined) },
      pendingAction: { create: vi.fn(async () => ({ id: "pending_1" })) }
    } as any;

    const tokenService = {
      getOAuthClientForUser: vi.fn(async () => ({}))
    } as any;

    const executor = new ToolExecutor(prisma, tokenService);

    const result = await executor.executeToolCall(
      "gmail_create_draft",
      { to: "brad@example.com", subject: "Meeting", body: "Thursday works." },
      {
        user: { id: "user_1", timezone: "America/New_York" } as any,
        conversation: { id: "conversation_1" } as any,
        latestUserMessage: "send an email to Brad saying Thursday works"
      }
    );

    expect(result.ok).toBe(true);
    expect(result.approvalRequired).not.toBe(true);
    expect(result.userMessage).toBeUndefined();
    expect(prisma.pendingAction.create).not.toHaveBeenCalled();
  });
});
