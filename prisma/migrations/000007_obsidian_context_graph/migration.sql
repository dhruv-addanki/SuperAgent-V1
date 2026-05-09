CREATE TABLE "ObsidianContextGraphNode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pcgId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "aliases" JSONB NOT NULL,
    "sourceIds" JSONB NOT NULL,
    "sourcePaths" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeen" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObsidianContextGraphNode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ObsidianContextGraphNode_userId_pcgId_key" ON "ObsidianContextGraphNode"("userId", "pcgId");
CREATE INDEX "ObsidianContextGraphNode_userId_type_idx" ON "ObsidianContextGraphNode"("userId", "type");
CREATE INDEX "ObsidianContextGraphNode_userId_confidence_idx" ON "ObsidianContextGraphNode"("userId", "confidence");
CREATE INDEX "ObsidianContextGraphNode_userId_indexedAt_idx" ON "ObsidianContextGraphNode"("userId", "indexedAt");

ALTER TABLE "ObsidianContextGraphNode" ADD CONSTRAINT "ObsidianContextGraphNode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
