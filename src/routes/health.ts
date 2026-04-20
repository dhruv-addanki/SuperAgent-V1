import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    service: "whatsapp-super-agent",
    timestamp: new Date().toISOString()
  }));
}
