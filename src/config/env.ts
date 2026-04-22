import "dotenv/config";
import { z } from "zod";

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .optional()
  .default(false)
  .transform((value) => {
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgresql://postgres:postgres@localhost:5432/whatsapp_super_agent?schema=public"),
    DIRECT_URL: z
      .string()
      .min(1)
      .optional()
      .default("postgresql://postgres:postgres@localhost:5432/whatsapp_super_agent?schema=public"),
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

    OPENAI_API_KEY: z.string().min(1).default("dev-openai-key"),
    OPENAI_MODEL: z.string().min(1).default("gpt-5.4"),

    APP_BASE_URL: z.string().url().default("http://localhost:3000"),
    WEBHOOK_PUBLIC_URL: z.string().optional().default(""),

    WHATSAPP_VERIFY_TOKEN: z.string().min(1).default("dev-verify-token"),
    WHATSAPP_ACCESS_TOKEN: z.string().min(1).default("dev-whatsapp-token"),
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).default("dev-phone-number-id"),
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional().default(""),
    WHATSAPP_APP_SECRET: z.string().optional().default(""),

    GOOGLE_CLIENT_ID: z.string().min(1).default("dev-google-client-id"),
    GOOGLE_CLIENT_SECRET: z.string().min(1).default("dev-google-client-secret"),
    GOOGLE_REDIRECT_URI: z.string().url().default("http://localhost:3000/auth/google/callback"),
    GOOGLE_READ_ONLY_MODE: booleanFromString,
    ASANA_CLIENT_ID: z.string().min(1).default("dev-asana-client-id"),
    ASANA_CLIENT_SECRET: z.string().min(1).default("dev-asana-client-secret"),
    ASANA_REDIRECT_URI: z.string().url().default("http://localhost:3000/auth/asana/callback"),
    READ_ONLY_MODE: booleanFromString,

    ENCRYPTION_KEY: z.string().min(1).default("dev-only-change-me"),

    LOG_LEVEL: z.string().default("info"),
    PENDING_ACTION_TTL_MINUTES: z.coerce.number().int().positive().default(30),
    MAX_TOOL_ROUNDS: z.coerce.number().int().positive().max(10).default(3),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30)
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== "production") return;

    const productionRequired: Array<keyof typeof value> = [
      "OPENAI_API_KEY",
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "ENCRYPTION_KEY"
    ];

    for (const key of productionRequired) {
      const stringValue = String(value[key] ?? "");
      if (stringValue.startsWith("dev-") || stringValue === "dev-only-change-me") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be set to a production value`
        });
      }
    }
  });

const parsedEnv = envSchema.parse(process.env);

export const env = {
  ...parsedEnv,
  READ_ONLY_MODE: parsedEnv.READ_ONLY_MODE || parsedEnv.GOOGLE_READ_ONLY_MODE,
  GOOGLE_READ_ONLY_MODE: parsedEnv.GOOGLE_READ_ONLY_MODE || parsedEnv.READ_ONLY_MODE
} as const;

export type AppEnv = typeof env;
