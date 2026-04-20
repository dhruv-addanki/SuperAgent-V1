import type { FastifyInstance } from "fastify";
import { googleCallbackQuerySchema, googleStartQuerySchema } from "../schemas/apiSchemas";
import type { GoogleOAuthService } from "../modules/google/googleOAuthService";

export async function registerGoogleAuthRoutes(
  app: FastifyInstance,
  googleOAuthService: GoogleOAuthService
): Promise<void> {
  app.get("/auth/google/start", async (request, reply) => {
    const query = googleStartQuerySchema.parse(request.query);
    return reply.redirect(googleOAuthService.getAuthUrl(query.phone));
  });

  app.get("/auth/google/callback", async (request, reply) => {
    const query = googleCallbackQuerySchema.parse(request.query);
    const result = await googleOAuthService.handleCallback(query.code, query.state);

    return reply.type("text/html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Google connected</title></head>
  <body>
    <h1>Google connected</h1>
    <p>${escapeHtml(result.email ?? "Your Google account")} is connected for ${escapeHtml(result.phone)}.</p>
    <p>You can close this tab and return to WhatsApp.</p>
  </body>
</html>`);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return replacements[char] ?? char;
  });
}
