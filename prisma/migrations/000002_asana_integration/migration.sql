CREATE TABLE "AsanaAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "asanaUserGid" TEXT NOT NULL,
    "asanaEmail" TEXT,
    "asanaName" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AsanaAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AsanaAccount_userId_key" ON "AsanaAccount"("userId");

ALTER TABLE "AsanaAccount" ADD CONSTRAINT "AsanaAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
