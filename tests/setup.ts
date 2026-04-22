process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/whatsapp_super_agent?schema=public";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-openai-key";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "test-encryption-key";
process.env.WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "verify";
process.env.WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? "dev-whatsapp-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "phone-id";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "google-client";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "google-secret";
process.env.GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/auth/google/callback";
process.env.ASANA_CLIENT_ID = process.env.ASANA_CLIENT_ID ?? "asana-client";
process.env.ASANA_CLIENT_SECRET = process.env.ASANA_CLIENT_SECRET ?? "asana-secret";
process.env.ASANA_REDIRECT_URI =
  process.env.ASANA_REDIRECT_URI ?? "http://localhost:3000/auth/asana/callback";
