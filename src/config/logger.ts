import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "*.accessToken",
      "*.refreshToken",
      "*.WHATSAPP_ACCESS_TOKEN",
      "*.OPENAI_API_KEY"
    ],
    censor: "[redacted]"
  },
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            singleLine: true,
            translateTime: "SYS:standard"
          }
        }
      : undefined
});
