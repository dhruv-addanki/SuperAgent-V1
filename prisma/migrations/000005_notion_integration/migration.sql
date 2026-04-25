CREATE TABLE "NotionAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "workspaceName" TEXT,
    "workspaceIcon" TEXT,
    "botId" TEXT,
    "ownerType" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiryDate" TIMESTAMP(3),
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotionAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotionAccount_userId_key" ON "NotionAccount"("userId");

ALTER TABLE "NotionAccount" ADD CONSTRAINT "NotionAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
