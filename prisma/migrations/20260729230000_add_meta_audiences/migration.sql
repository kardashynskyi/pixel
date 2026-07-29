-- CreateTable
CREATE TABLE "MetaMarketingConnection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "businessId" TEXT,
    "accessTokenCipher" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "accountName" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "verificationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaMarketingConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAudience" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "metaAudienceId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "audienceType" TEXT NOT NULL,
    "sourceAudienceId" TEXT,
    "segmentType" TEXT,
    "segmentConfig" JSONB,
    "destinationCountries" JSONB,
    "ratio" DOUBLE PRECISION,
    "customerCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "operationStatus" TEXT,
    "errorMessage" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAudience_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaMarketingConnection_shop_key"
ON "MetaMarketingConnection"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAudience_shop_metaAudienceId_key"
ON "MetaAudience"("shop", "metaAudienceId");

-- CreateIndex
CREATE INDEX "MetaAudience_shop_audienceType_idx"
ON "MetaAudience"("shop", "audienceType");

-- CreateIndex
CREATE INDEX "MetaAudience_shop_status_idx"
ON "MetaAudience"("shop", "status");

-- CreateIndex
CREATE INDEX "MetaAudience_shop_createdAt_idx"
ON "MetaAudience"("shop", "createdAt");
