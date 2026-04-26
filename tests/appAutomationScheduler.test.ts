import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function setProductionEnv(overrides: Record<string, string | undefined> = {}) {
  Object.assign(process.env, {
    NODE_ENV: "production",
    LOG_LEVEL: "silent",
    OPENAI_API_KEY: "prod-openai-key",
    WHATSAPP_VERIFY_TOKEN: "prod-verify-token",
    WHATSAPP_ACCESS_TOKEN: "prod-whatsapp-token",
    WHATSAPP_PHONE_NUMBER_ID: "prod-phone-number-id",
    GOOGLE_CLIENT_ID: "prod-google-client-id",
    GOOGLE_CLIENT_SECRET: "prod-google-client-secret",
    NOTION_CLIENT_ID: "prod-notion-client-id",
    NOTION_CLIENT_SECRET: "prod-notion-client-secret",
    NOTION_REDIRECT_URI: "https://example.com/auth/notion/callback",
    ENCRYPTION_KEY: "prod-encryption-key",
    APP_BASE_URL: "https://example.com"
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function importBuildAppWithSchedulerMock() {
  const start = vi.fn();
  const stop = vi.fn();
  const AutomationScheduler = vi.fn(() => ({ start, stop }));

  vi.doMock("../src/modules/automation/automationScheduler", () => ({
    AutomationScheduler
  }));

  const { buildApp } = await import("../src/app/app");
  return { buildApp, AutomationScheduler, start, stop };
}

describe("app automation scheduler configuration", () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("../src/modules/automation/automationScheduler");
  });

  it("starts the automation scheduler by default in production", async () => {
    setProductionEnv({ AUTOMATION_RUNNER_ENABLED: undefined });

    const { buildApp, AutomationScheduler, start, stop } = await importBuildAppWithSchedulerMock();
    const app = await buildApp({
      prisma: {} as any,
      responsesClient: { createResponse: vi.fn() } as any,
      whatsappService: {
        sendTextMessage: vi.fn(),
        sendTypingIndicator: vi.fn(),
        sendTemplateMessage: vi.fn()
      } as any,
      queue: null,
      startWorkers: false
    });

    expect(AutomationScheduler).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    await app.close();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not start the automation scheduler when production explicitly disables it", async () => {
    setProductionEnv({ AUTOMATION_RUNNER_ENABLED: "false" });

    const { buildApp, AutomationScheduler, start } = await importBuildAppWithSchedulerMock();
    const app = await buildApp({
      prisma: {} as any,
      responsesClient: { createResponse: vi.fn() } as any,
      whatsappService: {
        sendTextMessage: vi.fn(),
        sendTypingIndicator: vi.fn(),
        sendTemplateMessage: vi.fn()
      } as any,
      queue: null,
      startWorkers: false
    });

    expect(AutomationScheduler).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });
});
