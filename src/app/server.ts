import { env } from "../config/env";
import { logger } from "../config/logger";
import { buildApp } from "./app";

async function main() {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({
    port: env.PORT,
    host: "0.0.0.0"
  });

  logger.info({ port: env.PORT }, "WhatsApp Super Agent listening");
}

main().catch((error) => {
  logger.error({ error }, "Failed to start server");
  process.exit(1);
});
