import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGoogleAuthRoutes } from "../src/routes/authGoogle";

describe("Google auth routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
  });

  it("redirects to the Google OAuth URL", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);

    await registerGoogleAuthRoutes(app, {
      getAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?state=test"),
      handleCallback: vi.fn()
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/auth/google/start?phone=%2B15555550100"
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("accounts.google.com");
  });

  it("renders a minimal success page on callback", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);

    await registerGoogleAuthRoutes(app, {
      getAuthUrl: vi.fn(),
      handleCallback: vi.fn(async () => ({
        email: "user@example.com",
        phone: "+15555550100"
      }))
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=abc&state=def"
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Google connected");
  });
});
