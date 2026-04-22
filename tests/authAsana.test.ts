import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAsanaAuthRoutes } from "../src/routes/authAsana";

describe("Asana auth routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  it("redirects to the Asana OAuth URL", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);

    await registerAsanaAuthRoutes(app, {
      getAuthUrl: vi.fn(() => "https://app.asana.com/-/oauth_authorize?state=test"),
      handleCallback: vi.fn()
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/auth/asana/start?phone=%2B15555550100"
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("app.asana.com");
  });

  it("renders a minimal success page on callback", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);

    await registerAsanaAuthRoutes(app, {
      getAuthUrl: vi.fn(),
      handleCallback: vi.fn(async () => ({
        email: "user@example.com",
        name: "User Example",
        phone: "+15555550100"
      }))
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/auth/asana/callback?code=abc&state=def"
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Asana connected");
    expect(response.body).toContain("User Example");
  });
});
