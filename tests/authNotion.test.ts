import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNotionAuthRoutes } from "../src/routes/authNotion";

describe("Notion auth routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  it("redirects to the Notion OAuth URL", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);

    await registerNotionAuthRoutes(app, {
      getAuthUrl: vi.fn(() => "https://api.notion.com/v1/oauth/authorize?state=test"),
      handleCallback: vi.fn()
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/auth/notion/start?phone=%2B15555550100"
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("api.notion.com");
  });

  it("renders a minimal success page on callback", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);

    await registerNotionAuthRoutes(app, {
      getAuthUrl: vi.fn(),
      handleCallback: vi.fn(async () => ({
        phone: "+15555550100",
        workspaceName: "Dhruv HQ"
      }))
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/auth/notion/callback?code=abc&state=def"
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Notion connected");
    expect(response.body).toContain("Dhruv HQ");
  });
});
