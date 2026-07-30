-- CreateTable
CREATE TABLE "MetaAudienceSyncLog" (
    "id" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "operation" TEXT,
    "customerCount" INTEGER,
    "emailIdentifierCount" INTEGER,
    "phoneIdentifierCount" INTEGER,
    "identifiersSent" INTEGER,
    "identifiersReceived" INTEGER,
    "metaErrorType" TEXT,
    "metaErrorCode" INTEGER,
    "metaErrorSubcode" INTEGER,
    "metaTraceId" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaAudienceSyncLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MetaAudienceSyncLog_audienceId_startedAt_idx"
ON "MetaAudienceSyncLog"("audienceId", "startedAt");

CREATE INDEX "MetaAudienceSyncLog_shop_startedAt_idx"
ON "MetaAudienceSyncLog"("shop", "startedAt");

CREATE INDEX "MetaAudienceSyncLog_shop_status_startedAt_idx"
ON "MetaAudienceSyncLog"("shop", "status", "startedAt");

CREATE INDEX "MetaAudienceSyncLog_trigger_startedAt_idx"
ON "MetaAudienceSyncLog"("trigger", "startedAt");

ALTER TABLE "MetaAudienceSyncLog"
ADD CONSTRAINT "MetaAudienceSyncLog_audienceId_fkey"
FOREIGN KEY ("audienceId")
REFERENCES "MetaAudience"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
