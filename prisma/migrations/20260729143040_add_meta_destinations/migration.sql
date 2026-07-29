-- CreateTable
CREATE TABLE "MetaDestination" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pixelId" TEXT NOT NULL,
    "accessTokenCipher" TEXT NOT NULL,
    "testEventCode" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'PRODUCTION',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "browserTracking" BOOLEAN NOT NULL DEFAULT true,
    "serverTracking" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaDestination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaDestination_shop_pixelId_key"
ON "MetaDestination"("shop", "pixelId");

-- CreateIndex
CREATE INDEX "MetaDestination_shop_enabled_idx"
ON "MetaDestination"("shop", "enabled");

-- CreateIndex
CREATE INDEX "MetaDestination_shop_isPrimary_idx"
ON "MetaDestination"("shop", "isPrimary");
