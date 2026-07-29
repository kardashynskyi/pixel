-- CreateTable
CREATE TABLE "PixelSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "metaPixelId" TEXT,
    "metaAccessTokenCipher" TEXT,
    "metaTestEventCode" TEXT,
    "trackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "browserTracking" BOOLEAN NOT NULL DEFAULT true,
    "serverTracking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PixelSettings_shop_key" ON "PixelSettings"("shop");
