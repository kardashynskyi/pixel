-- CreateTable
CREATE TABLE "MetaEventDelivery" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "pixelId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "eventSourceUrl" TEXT,
    "browserAttempted" BOOLEAN NOT NULL DEFAULT false,
    "serverAttempted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "eventsReceived" INTEGER,
    "fbTraceId" TEXT,
    "errorMessage" TEXT,
    "errorType" TEXT,
    "errorCode" INTEGER,
    "errorSubcode" INTEGER,
    "errorIsTransient" BOOLEAN,
    "errorUserTitle" TEXT,
    "errorUserMessage" TEXT,
    "hasClientIp" BOOLEAN NOT NULL DEFAULT false,
    "hasClientUserAgent" BOOLEAN NOT NULL DEFAULT false,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaEventDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaEventDelivery_shop_createdAt_idx" ON "MetaEventDelivery"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "MetaEventDelivery_shop_status_createdAt_idx" ON "MetaEventDelivery"("shop", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MetaEventDelivery_shop_eventName_createdAt_idx" ON "MetaEventDelivery"("shop", "eventName", "createdAt");

-- CreateIndex
CREATE INDEX "MetaEventDelivery_shop_eventId_idx" ON "MetaEventDelivery"("shop", "eventId");
