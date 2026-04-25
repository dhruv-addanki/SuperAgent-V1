import type { FastifyInstance } from "fastify";
import { notionCallbackQuerySchema, notionStartQuerySchema } from "../schemas/apiSchemas";
import type { NotionOAuthService } from "../modules/notion/notionOAuthService";

export async function registerNotionAuthRoutes(
  app: FastifyInstance,
  notionOAuthService: NotionOAuthService
): Promise<void> {
  app.get("/auth/notion/start", async (request, reply) => {
    const query = notionStartQuerySchema.parse(request.query);
    return reply.redirect(notionOAuthService.getAuthUrl(query.phone));
  });

  app.get("/auth/notion/callback", async (request, reply) => {
    const query = notionCallbackQuerySchema.parse(request.query);
    const result = await notionOAuthService.handleCallback(query.code, query.state);

    return reply.type("text/html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Notion connected</title></head>
  <body>
    <h1>Notion connected</h1>
    <p>${escapeHtml(result.workspaceName ?? "Your Notion workspace")} is connected for ${escapeHtml(result.phone)}.</p>
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
