CREATE TYPE "MessageSenderType" AS ENUM ('user', 'agent', 'tool', 'system');

ALTER TABLE "Message"
ADD COLUMN "senderType" "MessageSenderType" NOT NULL DEFAULT 'user',
ADD COLUMN "senderPhone" TEXT;

UPDATE "Message"
SET "senderType" = CASE "role"
  WHEN 'assistant' THEN 'agent'::"MessageSenderType"
  WHEN 'tool' THEN 'tool'::"MessageSenderType"
  WHEN 'system' THEN 'system'::"MessageSenderType"
  ELSE 'user'::"MessageSenderType"
END;

CREATE INDEX "Message_senderPhone_createdAt_idx" ON "Message"("senderPhone", "createdAt");
