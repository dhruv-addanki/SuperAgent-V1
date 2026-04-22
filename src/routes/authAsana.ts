import type { FastifyInstance } from "fastify";
import { asanaCallbackQuerySchema, asanaStartQuerySchema } from "../schemas/apiSchemas";
import type { AsanaOAuthService } from "../modules/asana/asanaOAuthService";

export async function registerAsanaAuthRoutes(
  app: FastifyInstance,
  asanaOAuthService: AsanaOAuthService
): Promise<void> {
  app.get("/auth/asana/start", async (request, reply) => {
    const query = asanaStartQuerySchema.parse(request.query);
    return reply.redirect(asanaOAuthService.getAuthUrl(query.phone));
  });

  app.get("/auth/asana/callback", async (request, reply) => {
    const query = asanaCallbackQuerySchema.parse(request.query);
    const result = await asanaOAuthService.handleCallback(query.code, query.state);

    return reply.type("text/html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Asana connected</title></head>
  <body>
    <h1>Asana connected</h1>
    <p>${escapeHtml(result.name ?? result.email ?? "Your Asana account")} is connected for ${escapeHtml(result.phone)}.</p>
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
