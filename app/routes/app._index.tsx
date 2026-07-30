import { createHash } from "node:crypto";
import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../encryption.server";
import { authenticate } from "../shopify.server";

type AdminClient = Awaited<
  ReturnType<typeof authenticate.admin>
>["admin"];

type ShopifyCustomerNode = {
  id: string;
  defaultEmailAddress?: {
    emailAddress?: string | null;
    marketingState?: string | null;
    validFormat?: boolean | null;
  } | null;
  defaultPhoneNumber?: {
    phoneNumber?: string | null;
    marketingState?: string | null;
  } | null;
};

type ShopifyCustomersResponse = {
  data?: {
    customers?: {
      nodes?: ShopifyCustomerNode[];
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
      };
    };
  };
  errors?: Array<{
    message: string;
  }>;
};

type MetaApiError = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

type MetaAudienceCreateResponse =
  MetaApiError & {
    id?: string;
  };

type MetaAudienceUploadResponse =
  MetaApiError & {
    audience_id?: string;
    num_received?: number;
    num_invalid_entries?: number;
    session_id?: string;
  };

type WebPixelRecord = {
  id: string;
  settings: string;
};

type WebPixelQueryResponse = {
  data?: {
    webPixel?: WebPixelRecord | null;
  };
  errors?: Array<{
    message: string;
  }>;
};

type WebPixelMutationResult = {
  webPixel?: WebPixelRecord | null;
  userErrors: Array<{
    field?: string[] | null;
    message: string;
  }>;
};

type WebPixelMutationResponse = {
  data?: {
    webPixelCreate?: WebPixelMutationResult | null;
    webPixelUpdate?: WebPixelMutationResult | null;
  };
  errors?: Array<{
    message: string;
  }>;
};

type ActionData = {
  success: boolean;
  message: string;
  webPixelId?: string;
};

function getGraphqlErrors(
  errors: Array<{ message: string }> | undefined,
): string | null {
  if (!errors?.length) {
    return null;
  }

  return errors
    .map((error) => error.message)
    .join("; ");
}

function getUserErrors(
  result: WebPixelMutationResult | null | undefined,
): string | null {
  if (!result?.userErrors?.length) {
    return null;
  }

  return result.userErrors
    .map((error) => error.message)
    .join("; ");
}

function isNoWebPixelError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  if (
    message
      .toLowerCase()
      .includes("no web pixel was found")
  ) {
    return true;
  }

  const possibleError = error as {
    body?: {
      data?: {
        webPixel?: WebPixelRecord | null;
      };
      errors?: {
        graphQLErrors?: Array<{
          message?: string;
        }>;
      };
    };
  };

  if (possibleError.body?.data?.webPixel === null) {
    return true;
  }

  return Boolean(
    possibleError.body?.errors?.graphQLErrors?.some(
      (graphQLError) =>
        String(graphQLError.message ?? "")
          .toLowerCase()
          .includes("no web pixel was found"),
    ),
  );
}

async function getCurrentWebPixel(
  admin: AdminClient,
): Promise<WebPixelRecord | null> {
  try {
    const response = await admin.graphql(
      `#graphql
        query CurrentWebPixel {
          webPixel {
            id
            settings
          }
        }
      `,
    );

    const json =
      (await response.json()) as WebPixelQueryResponse;

    const graphqlError =
      getGraphqlErrors(json.errors);

    if (graphqlError) {
      if (
        graphqlError
          .toLowerCase()
          .includes("no web pixel was found")
      ) {
        return null;
      }

      throw new Error(graphqlError);
    }

    return json.data?.webPixel ?? null;
  } catch (error) {
    if (isNoWebPixelError(error)) {
      return null;
    }

    throw error;
  }
}

async function createWebPixel(
  admin: AdminClient,
  settings: Record<string, string>,
): Promise<WebPixelRecord> {
  const response = await admin.graphql(
    `#graphql
      mutation CreateWebPixel(
        $webPixel: WebPixelInput!
      ) {
        webPixelCreate(webPixel: $webPixel) {
          webPixel {
            id
            settings
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        webPixel: {
          settings,
        },
      },
    },
  );

  const json =
    (await response.json()) as WebPixelMutationResponse;

  const graphqlError =
    getGraphqlErrors(json.errors);

  if (graphqlError) {
    throw new Error(graphqlError);
  }

  const result = json.data?.webPixelCreate;
  const userError = getUserErrors(result);

  if (userError) {
    throw new Error(userError);
  }

  if (!result?.webPixel) {
    throw new Error(
      "Shopify did not return the created Web Pixel.",
    );
  }

  return result.webPixel;
}

async function updateWebPixel(
  admin: AdminClient,
  id: string,
  settings: Record<string, string>,
): Promise<WebPixelRecord> {
  const response = await admin.graphql(
    `#graphql
      mutation UpdateWebPixel(
        $id: ID!
        $webPixel: WebPixelInput!
      ) {
        webPixelUpdate(
          id: $id
          webPixel: $webPixel
        ) {
          webPixel {
            id
            settings
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id,
        webPixel: {
          settings,
        },
      },
    },
  );

  const json =
    (await response.json()) as WebPixelMutationResponse;

  const graphqlError =
    getGraphqlErrors(json.errors);

  if (graphqlError) {
    throw new Error(graphqlError);
  }

  const result = json.data?.webPixelUpdate;
  const userError = getUserErrors(result);

  if (userError) {
    throw new Error(userError);
  }

  if (!result?.webPixel) {
    throw new Error(
      "Shopify did not return the updated Web Pixel.",
    );
  }

  return result.webPixel;
}


function normalizeEmail(
  value: string | null | undefined,
): string | null {
  const normalized =
    value?.trim().toLowerCase() ?? "";

  return normalized.includes("@")
    ? normalized
    : null;
}

function normalizePhone(
  value: string | null | undefined,
): string | null {
  const normalized =
    value?.replace(/\D/g, "") ?? "";

  return normalized.length >= 7
    ? normalized
    : null;
}

function sha256(value: string): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function getMetaErrorMessage(
  body: MetaApiError,
  fallback: string,
): string {
  const error = body.error;

  if (!error) {
    return fallback;
  }

  const details = [
    error.message ?? fallback,
    error.type
      ? `type=${error.type}`
      : null,
    typeof error.code === "number"
      ? `code=${error.code}`
      : null,
    typeof error.error_subcode === "number"
      ? `subcode=${error.error_subcode}`
      : null,
    error.fbtrace_id
      ? `trace=${error.fbtrace_id}`
      : null,
  ].filter(Boolean);

  return details.join(" | ");
}

function getMetaErrorDiagnostics(
  body: MetaApiError,
): {
  message: string | null;
  type: string | null;
  code: number | null;
  subcode: number | null;
  traceId: string | null;
} {
  return {
    message:
      body.error?.message ?? null,
    type:
      body.error?.type ?? null,
    code:
      typeof body.error?.code === "number"
        ? body.error.code
        : null,
    subcode:
      typeof body.error?.error_subcode === "number"
        ? body.error.error_subcode
        : null,
    traceId:
      body.error?.fbtrace_id ?? null,
  };
}

async function getShopifyAudienceIdentifiers(
  admin: AdminClient,
): Promise<{
  customerCount: number;
  emailHashes: string[];
  phoneHashes: string[];
}> {
  const emailHashes = new Set<string>();
  const phoneHashes = new Set<string>();
  const eligibleCustomerIds = new Set<string>();

  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query AudienceCustomers(
          $first: Int!
          $after: String
        ) {
          customers(
            first: $first
            after: $after
          ) {
            nodes {
              id
              defaultEmailAddress {
                emailAddress
                marketingState
                validFormat
              }
              defaultPhoneNumber {
                phoneNumber
                marketingState
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          first: 100,
          after,
        },
      },
    );

    const json =
      (await response.json()) as ShopifyCustomersResponse;

    const graphqlError =
      getGraphqlErrors(json.errors);

    if (graphqlError) {
      throw new Error(
        `Shopify customer query failed: ${graphqlError}`,
      );
    }

    const connection =
      json.data?.customers;

    for (const customer of
      connection?.nodes ?? []) {
      let included = false;

      const emailState =
        customer.defaultEmailAddress
          ?.marketingState;

      const email = normalizeEmail(
        customer.defaultEmailAddress
          ?.emailAddress,
      );

      if (
        email &&
        customer.defaultEmailAddress
          ?.validFormat !== false &&
        emailState === "SUBSCRIBED"
      ) {
        emailHashes.add(sha256(email));
        included = true;
      }

      const phoneState =
        customer.defaultPhoneNumber
          ?.marketingState;

      const phone = normalizePhone(
        customer.defaultPhoneNumber
          ?.phoneNumber,
      );

      if (
        phone &&
        phoneState === "SUBSCRIBED"
      ) {
        phoneHashes.add(sha256(phone));
        included = true;
      }

      if (included) {
        eligibleCustomerIds.add(
          customer.id,
        );
      }
    }

    hasNextPage =
      connection?.pageInfo
        ?.hasNextPage === true;

    after =
      connection?.pageInfo
        ?.endCursor ?? null;

    if (hasNextPage && !after) {
      throw new Error(
        "Shopify pagination did not return an end cursor.",
      );
    }
  }

  return {
    customerCount:
      eligibleCustomerIds.size,
    emailHashes: [...emailHashes],
    phoneHashes: [...phoneHashes],
  };
}

async function uploadMetaAudienceHashes({
  apiVersion,
  audienceId,
  accessToken,
  schema,
  hashes,
}: {
  apiVersion: string;
  audienceId: string;
  accessToken: string;
  schema: "EMAIL" | "PHONE";
  hashes: string[];
}): Promise<number> {
  let totalReceived = 0;

  for (
    let index = 0;
    index < hashes.length;
    index += 10000
  ) {
    const batch = hashes.slice(
      index,
      index + 10000,
    );

    const body = new URLSearchParams();
    body.set(
      "access_token",
      accessToken,
    );
    body.set(
      "payload",
      JSON.stringify({
        schema: [schema],
        data: batch.map((hash) => [
          hash,
        ]),
      }),
    );

    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(
        audienceId,
      )}/users`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body,
      },
    );

    const responseBody =
      (await response.json()) as MetaAudienceUploadResponse;

    if (
      !response.ok ||
      responseBody.error
    ) {
      const diagnostics =
        getMetaErrorDiagnostics(
          responseBody,
        );

      console.error(
        "Meta audience identifier upload failed",
        {
          audienceId,
          schema,
          httpStatus: response.status,
          diagnostics,
        },
      );

      throw new Error(
        getMetaErrorMessage(
          responseBody,
          `Meta rejected the ${schema} audience upload.`,
        ),
      );
    }

    totalReceived +=
      responseBody.num_received ??
      batch.length;
  }

  return totalReceived;
}

async function replaceMetaAudienceHashes({
  apiVersion,
  audienceId,
  accessToken,
  emailHashes,
  phoneHashes,
}: {
  apiVersion: string;
  audienceId: string;
  accessToken: string;
  emailHashes: string[];
  phoneHashes: string[];
}): Promise<number> {
  const rows = [
    ...emailHashes.map((hash) => [
      hash,
      "",
    ]),
    ...phoneHashes.map((hash) => [
      "",
      hash,
    ]),
  ];

  if (!rows.length) {
    throw new Error(
      "No subscribed customer identifiers are available to replace this audience.",
    );
  }

  const sessionId =
    Date.now() * 1000 +
    Math.floor(Math.random() * 1000);

  let totalReceived = 0;
  let batchSequence = 1;

  for (
    let index = 0;
    index < rows.length;
    index += 10000
  ) {
    const batch = rows.slice(
      index,
      index + 10000,
    );

    const isLastBatch =
      index + 10000 >= rows.length;

    const body = new URLSearchParams();

    body.set(
      "access_token",
      accessToken,
    );

    body.set(
      "session",
      JSON.stringify({
        session_id: sessionId,
        batch_seq: batchSequence,
        last_batch_flag: isLastBatch,
        estimated_num_total:
          rows.length,
      }),
    );

    body.set(
      "payload",
      JSON.stringify({
        schema: ["EMAIL", "PHONE"],
        data: batch,
      }),
    );

    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(
        audienceId,
      )}/usersreplace`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body,
      },
    );

    const responseBody =
      (await response.json()) as MetaAudienceUploadResponse;

    if (
      !response.ok ||
      responseBody.error
    ) {
      const diagnostics =
        getMetaErrorDiagnostics(
          responseBody,
        );

      console.error(
        "Meta audience replacement failed",
        {
          audienceId,
          httpStatus: response.status,
          batchSequence,
          isLastBatch,
          diagnostics,
        },
      );

      throw new Error(
        getMetaErrorMessage(
          responseBody,
          "Meta rejected the audience replacement.",
        ),
      );
    }

    totalReceived +=
      responseBody.num_received ??
      batch.length;

    batchSequence += 1;
  }

  return totalReceived;
}

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  const { admin, session } =
    await authenticate.admin(request);

  const settings =
    await db.pixelSettings.findUnique({
      where: {
        shop: session.shop,
      },
    });

  const webPixel =
    await getCurrentWebPixel(admin);

  const [
    destinations,
    marketingConnection,
    audiences,
  ] = await Promise.all([
    db.metaDestination.findMany({
      where: {
        shop: session.shop,
      },
      orderBy: [
        {
          isPrimary: "desc",
        },
        {
          createdAt: "asc",
        },
      ],
      select: {
        id: true,
        name: true,
        pixelId: true,
        mode: true,
        enabled: true,
        isPrimary: true,
        browserTracking: true,
        serverTracking: true,
        testEventCode: true,
        accessTokenCipher: true,
      },
    }),
    db.metaMarketingConnection.findUnique({
      where: {
        shop: session.shop,
      },
    }),
    db.metaAudience.findMany({
      where: {
        shop: session.shop,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    }),
  ]);

  const diagnosticsSince = new Date(
    Date.now() - 24 * 60 * 60 * 1000,
  );

  const [
    attemptedCount,
    deliveredCount,
    rejectedCount,
    failedCount,
    lastDelivered,
    eventGroups,
    recentEvents,
    destinationGroups,
    destinationLastDeliveries,
    destinationRecentFailures,
    delayedCount,
  ] = await Promise.all([
    db.metaEventDelivery.count({
      where: {
        shop: session.shop,
        createdAt: {
          gte: diagnosticsSince,
        },
      },
    }),
    db.metaEventDelivery.count({
      where: {
        shop: session.shop,
        status: "DELIVERED",
        createdAt: {
          gte: diagnosticsSince,
        },
      },
    }),
    db.metaEventDelivery.count({
      where: {
        shop: session.shop,
        status: "REJECTED",
        createdAt: {
          gte: diagnosticsSince,
        },
      },
    }),
    db.metaEventDelivery.count({
      where: {
        shop: session.shop,
        status: "FAILED",
        createdAt: {
          gte: diagnosticsSince,
        },
      },
    }),
    db.metaEventDelivery.findFirst({
      where: {
        shop: session.shop,
        status: "DELIVERED",
      },
      orderBy: {
        deliveredAt: "desc",
      },
      select: {
        deliveredAt: true,
        eventName: true,
      },
    }),
    db.metaEventDelivery.groupBy({
      by: ["eventName"],
      where: {
        shop: session.shop,
        createdAt: {
          gte: diagnosticsSince,
        },
      },
      _count: {
        _all: true,
      },
    }),
    db.metaEventDelivery.findMany({
      where: {
        shop: session.shop,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
      select: {
        id: true,
        pixelId: true,
        eventName: true,
        eventId: true,
        status: true,
        httpStatus: true,
        eventsReceived: true,
        testMode: true,
        errorMessage: true,
        eventTime: true,
        createdAt: true,
        deliveredAt: true,
      },
    }),
    db.metaEventDelivery.groupBy({
      by: ["pixelId", "status"],
      where: {
        shop: session.shop,
        createdAt: {
          gte: diagnosticsSince,
        },
      },
      _count: {
        _all: true,
      },
    }),
    db.metaEventDelivery.findMany({
      where: {
        shop: session.shop,
        status: "DELIVERED",
      },
      orderBy: {
        deliveredAt: "desc",
      },
      distinct: ["pixelId"],
      select: {
        pixelId: true,
        eventName: true,
        deliveredAt: true,
      },
    }),
    db.metaEventDelivery.findMany({
      where: {
        shop: session.shop,
        status: {
          in: ["REJECTED", "FAILED"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 10,
      select: {
        id: true,
        pixelId: true,
        eventName: true,
        status: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
    db.metaEventDelivery.findMany({
      where: {
        shop: session.shop,
        status: "DELIVERED",
        deliveredAt: {
          gte: diagnosticsSince,
        },
      },
      select: {
        eventTime: true,
        deliveredAt: true,
      },
    }),
  ]);

  const delayedDeliveryCount =
    delayedCount.filter(
      (event) =>
        event.deliveredAt &&
        event.deliveredAt.getTime() -
          event.eventTime.getTime() >
          5 * 60 * 1000,
    ).length;

  const acceptanceRate =
    attemptedCount > 0
      ? Math.round(
          (deliveredCount / attemptedCount) *
            1000,
        ) / 10
      : 0;

  const destinationDiagnostics =
    destinations.map((destination) => {
      const groupedRows =
        destinationGroups.filter(
          (group) =>
            group.pixelId ===
            destination.pixelId,
        );

      const attempted = groupedRows.reduce(
        (total, group) =>
          total + group._count._all,
        0,
      );

      const delivered =
        groupedRows.find(
          (group) =>
            group.status === "DELIVERED",
        )?._count._all ?? 0;

      const rejected =
        groupedRows.find(
          (group) =>
            group.status === "REJECTED",
        )?._count._all ?? 0;

      const failed =
        groupedRows.find(
          (group) =>
            group.status === "FAILED",
        )?._count._all ?? 0;

      const pending =
        groupedRows.find(
          (group) =>
            group.status === "PENDING",
        )?._count._all ?? 0;

      const rate =
        attempted > 0
          ? Math.round(
              (delivered / attempted) *
                1000,
            ) / 10
          : 0;

      const lastDelivery =
        destinationLastDeliveries.find(
          (row) =>
            row.pixelId ===
            destination.pixelId,
        );

      return {
        id: destination.id,
        name: destination.name,
        pixelId: destination.pixelId,
        mode: destination.mode,
        enabled: destination.enabled,
        isPrimary: destination.isPrimary,
        attempted,
        delivered,
        rejected,
        failed,
        pending,
        acceptanceRate: rate,
        health:
          !destination.enabled
            ? "Disabled"
            : rejected > 0 || failed > 0
              ? "Warning"
              : delivered > 0
                ? "Healthy"
                : "No recent data",
        lastDelivery: lastDelivery
          ? {
              eventName:
                lastDelivery.eventName,
              deliveredAt:
                lastDelivery.deliveredAt?.toISOString() ??
                null,
            }
          : null,
      };
    });

  return {
    shop: session.shop,
    settings: {
      metaPixelId:
        settings?.metaPixelId ?? "",
      metaTestEventCode:
        settings?.metaTestEventCode ?? "",
      metaMode:
        settings?.metaMode ?? "TEST",
      trackingEnabled:
        settings?.trackingEnabled ?? false,
      browserTracking:
        settings?.browserTracking ?? true,
      serverTracking:
        settings?.serverTracking ?? false,
      hasAccessToken: Boolean(
        settings?.metaAccessTokenCipher,
      ),
      accessTokenEncrypted: Boolean(
        settings?.metaAccessTokenCipher &&
          isEncryptedSecret(
            settings.metaAccessTokenCipher,
          ),
      ),
    },
    webPixel: webPixel
      ? {
          id: webPixel.id,
          settings: webPixel.settings,
        }
      : null,
    destinations: destinations.map(
      (destination) => ({
        id: destination.id,
        name: destination.name,
        pixelId: destination.pixelId,
        mode: destination.mode,
        enabled: destination.enabled,
        isPrimary: destination.isPrimary,
        browserTracking:
          destination.browserTracking,
        serverTracking:
          destination.serverTracking,
        testEventCode:
          destination.testEventCode ?? "",
        hasAccessToken: Boolean(
          destination.accessTokenCipher,
        ),
        accessTokenEncrypted:
          isEncryptedSecret(
            destination.accessTokenCipher,
          ),
      }),
    ),
    marketingConnection:
      marketingConnection
        ? {
            adAccountId:
              marketingConnection.adAccountId,
            businessId:
              marketingConnection.businessId ??
              "",
            enabled:
              marketingConnection.enabled,
            verified:
              marketingConnection.verified,
            accountName:
              marketingConnection.accountName ??
              "",
            hasAccessToken: Boolean(
              marketingConnection.accessTokenCipher,
            ),
            accessTokenEncrypted:
              isEncryptedSecret(
                marketingConnection.accessTokenCipher,
              ),
            lastVerifiedAt:
              marketingConnection.lastVerifiedAt?.toISOString() ??
              null,
            verificationError:
              marketingConnection.verificationError ??
              null,
          }
        : null,
    audiences: audiences.map((audience) => ({
      id: audience.id,
      metaAudienceId:
        audience.metaAudienceId ?? "",
      name: audience.name,
      audienceType: audience.audienceType,
      status: audience.status,
      customerCount:
        audience.customerCount,
      operationStatus:
        audience.operationStatus ?? "",
      errorMessage:
        audience.errorMessage ?? "",
      lastSyncedAt:
        audience.lastSyncedAt?.toISOString() ??
        null,
      createdAt:
        audience.createdAt.toISOString(),
    })),
    diagnostics: {
      windowLabel: "Last 24 hours",
      attemptedCount,
      deliveredCount,
      rejectedCount,
      failedCount,
      acceptanceRate,
      lastDelivered: lastDelivered
        ? {
            eventName:
              lastDelivered.eventName,
            deliveredAt:
              lastDelivered.deliveredAt?.toISOString() ??
              null,
          }
        : null,
      eventTotals: eventGroups
        .map((group) => ({
          eventName: group.eventName,
          count: group._count._all,
        }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.eventName.localeCompare(
              b.eventName,
            ),
        ),
      recentEvents: recentEvents.map(
        (event) => ({
          ...event,
          eventTime:
            event.eventTime.toISOString(),
          createdAt:
            event.createdAt.toISOString(),
          deliveredAt:
            event.deliveredAt?.toISOString() ??
            null,
          delayed:
            event.deliveredAt
              ? event.deliveredAt.getTime() -
                  event.eventTime.getTime() >
                5 * 60 * 1000
              : false,
        }),
      ),
      delayedCount: delayedDeliveryCount,
      destinationDiagnostics,
      recentFailures:
        destinationRecentFailures.map(
          (event) => ({
            ...event,
            createdAt:
              event.createdAt.toISOString(),
          }),
        ),
    },
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session } =
    await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(
    formData.get("intent") ?? "save_settings",
  );

  try {
    if (
      intent === "audience_refresh_customer_file"
    ) {
      const audienceId = String(
        formData.get("audienceId") ?? "",
      );

      const audience =
        await db.metaAudience.findFirst({
          where: {
            id: audienceId,
            shop: session.shop,
          },
        });

      if (
        !audience ||
        !audience.metaAudienceId
      ) {
        return {
          success: false,
          message:
            "The Meta audience was not found or does not have a Meta audience ID.",
        };
      }

      const connection =
        await db.metaMarketingConnection.findUnique({
          where: {
            shop: session.shop,
          },
        });

      if (
        !connection ||
        !connection.enabled ||
        !connection.verified
      ) {
        return {
          success: false,
          message:
            "Verify the Meta Marketing API connection before refreshing an audience.",
        };
      }

      let accessToken: string;

      try {
        accessToken =
          isEncryptedSecret(
            connection.accessTokenCipher,
          )
            ? decryptSecret(
                connection.accessTokenCipher,
              )
            : connection.accessTokenCipher;
      } catch {
        return {
          success: false,
          message:
            "The Marketing API token could not be decrypted. Save and verify the connection again.",
        };
      }

      await db.metaAudience.update({
        where: {
          id: audience.id,
        },
        data: {
          status: "SYNCING",
          operationStatus:
            "READING_SHOPIFY_CUSTOMERS",
          errorMessage: null,
        },
      });

      try {
        const identifiers =
          await getShopifyAudienceIdentifiers(
            admin,
          );

        if (
          identifiers.customerCount ===
          0
        ) {
          throw new Error(
            "No Shopify customers with subscribed email or SMS marketing consent and a usable identifier were found.",
          );
        }

        await db.metaAudience.update({
          where: {
            id: audience.id,
          },
          data: {
            customerCount:
              identifiers.customerCount,
            operationStatus:
              "REPLACING_META_AUDIENCE",
          },
        });

        const apiVersion =
          process.env
            .META_GRAPH_API_VERSION ??
          "v25.0";

        const identifiersReceived =
          await replaceMetaAudienceHashes({
            apiVersion,
            audienceId:
              audience.metaAudienceId,
            accessToken,
            emailHashes:
              identifiers.emailHashes,
            phoneHashes:
              identifiers.phoneHashes,
          });

        await db.metaAudience.update({
          where: {
            id: audience.id,
          },
          data: {
            status: "ACTIVE",
            customerCount:
              identifiers.customerCount,
            operationStatus:
              `REPLACED_${identifiersReceived}_IDENTIFIERS`,
            errorMessage: null,
            lastSyncedAt: new Date(),
          },
        });

        return {
          success: true,
          message:
            `Audience refreshed. ${identifiers.customerCount} consented Shopify customer records were processed while preserving Meta audience ${audience.metaAudienceId}.`,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "The audience could not be refreshed.";

        await db.metaAudience.update({
          where: {
            id: audience.id,
          },
          data: {
            status: "ERROR",
            operationStatus:
              "REFRESH_FAILED",
            errorMessage,
          },
        });

        return {
          success: false,
          message: errorMessage,
        };
      }
    }

    if (
      intent === "audience_create_customer_file"
    ) {
      const audienceName = String(
        formData.get("audienceName") ??
          "",
      ).trim();

      const audienceDescription =
        String(
          formData.get(
            "audienceDescription",
          ) ?? "",
        ).trim() || null;

      const confirmed =
        formData.get(
          "audienceTermsConfirmed",
        ) === "on";

      if (!audienceName) {
        return {
          success: false,
          message:
            "Enter a name for the Custom Audience.",
        };
      }

      if (!confirmed) {
        return {
          success: false,
          message:
            "Confirm that the customer information may be used for this audience and that Meta's Custom Audience terms have been accepted.",
        };
      }

      const connection =
        await db.metaMarketingConnection.findUnique({
          where: {
            shop: session.shop,
          },
        });

      if (
        !connection ||
        !connection.enabled ||
        !connection.verified
      ) {
        return {
          success: false,
          message:
            "Verify the Meta Marketing API connection before creating an audience.",
        };
      }

      let accessToken: string;

      try {
        accessToken =
          isEncryptedSecret(
            connection.accessTokenCipher,
          )
            ? decryptSecret(
                connection.accessTokenCipher,
              )
            : connection.accessTokenCipher;
      } catch {
        return {
          success: false,
          message:
            "The Marketing API token could not be decrypted. Save and verify the connection again.",
        };
      }

      const localAudience =
        await db.metaAudience.create({
          data: {
            shop: session.shop,
            name: audienceName,
            description:
              audienceDescription,
            audienceType:
              "CUSTOMER_FILE",
            segmentType:
              "MARKETING_SUBSCRIBERS",
            segmentConfig: {
              emailMarketingState:
                "SUBSCRIBED",
              smsMarketingState:
                "SUBSCRIBED",
            },
            status: "SYNCING",
            operationStatus:
              "READING_SHOPIFY_CUSTOMERS",
          },
        });

      let metaAudienceId:
        | string
        | null = null;

      try {
        const identifiers =
          await getShopifyAudienceIdentifiers(
            admin,
          );

        if (
          identifiers.customerCount ===
          0
        ) {
          throw new Error(
            "No Shopify customers with subscribed email or SMS marketing consent and a usable identifier were found.",
          );
        }

        await db.metaAudience.update({
          where: {
            id: localAudience.id,
          },
          data: {
            customerCount:
              identifiers.customerCount,
            operationStatus:
              "CREATING_META_AUDIENCE",
          },
        });

        const apiVersion =
          process.env
            .META_GRAPH_API_VERSION ??
          "v25.0";

        const createBody =
          new URLSearchParams();

        createBody.set(
          "access_token",
          accessToken,
        );
        createBody.set(
          "name",
          audienceName,
        );
        createBody.set(
          "subtype",
          "CUSTOM",
        );
        createBody.set(
          "customer_file_source",
          "USER_PROVIDED_ONLY",
        );

        if (audienceDescription) {
          createBody.set(
            "description",
            audienceDescription,
          );
        }

        const createResponse =
          await fetch(
            `https://graph.facebook.com/${apiVersion}/act_${encodeURIComponent(
              connection.adAccountId,
            )}/customaudiences`,
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/x-www-form-urlencoded",
              },
              body: createBody,
            },
          );

        const createResponseBody =
          (await createResponse.json()) as MetaAudienceCreateResponse;

        if (
          !createResponse.ok ||
          createResponseBody.error ||
          !createResponseBody.id
        ) {
          const diagnostics =
            getMetaErrorDiagnostics(
              createResponseBody,
            );

          console.error(
            "Meta Custom Audience creation failed",
            {
              shop: session.shop,
              adAccountId:
                connection.adAccountId,
              audienceName,
              httpStatus:
                createResponse.status,
              diagnostics,
            },
          );

          throw new Error(
            getMetaErrorMessage(
              createResponseBody,
              "Meta did not create the Custom Audience.",
            ),
          );
        }

        metaAudienceId =
          createResponseBody.id;

        await db.metaAudience.update({
          where: {
            id: localAudience.id,
          },
          data: {
            metaAudienceId,
            operationStatus:
              "UPLOADING_IDENTIFIERS",
          },
        });

        const emailReceived =
          identifiers.emailHashes.length
            ? await uploadMetaAudienceHashes({
                apiVersion,
                audienceId:
                  metaAudienceId,
                accessToken,
                schema: "EMAIL",
                hashes:
                  identifiers.emailHashes,
              })
            : 0;

        const phoneReceived =
          identifiers.phoneHashes.length
            ? await uploadMetaAudienceHashes({
                apiVersion,
                audienceId:
                  metaAudienceId,
                accessToken,
                schema: "PHONE",
                hashes:
                  identifiers.phoneHashes,
              })
            : 0;

        await db.metaAudience.update({
          where: {
            id: localAudience.id,
          },
          data: {
            status: "ACTIVE",
            operationStatus:
              `UPLOADED_${emailReceived}_EMAIL_${phoneReceived}_PHONE`,
            errorMessage: null,
            lastSyncedAt: new Date(),
          },
        });

        return {
          success: true,
          message:
            `Custom Audience created. ${identifiers.customerCount} consented Shopify customer records were processed.`,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "The Custom Audience could not be created.";

        await db.metaAudience.update({
          where: {
            id: localAudience.id,
          },
          data: {
            metaAudienceId,
            status: "ERROR",
            operationStatus:
              "SYNC_FAILED",
            errorMessage,
          },
        });

        return {
          success: false,
          message: errorMessage,
        };
      }
    }

    if (
      intent === "marketing_connection_save"
    ) {
      const rawAdAccountId = String(
        formData.get("adAccountId") ?? "",
      ).trim();

      const adAccountId =
        rawAdAccountId
          .replace(/^act_/i, "")
          .replace(/\s/g, "");

      const businessId =
        String(
          formData.get("businessId") ?? "",
        ).trim() || null;

      const submittedToken = String(
        formData.get(
          "marketingAccessToken",
        ) ?? "",
      ).trim();

      if (!/^\d+$/.test(adAccountId)) {
        return {
          success: false,
          message:
            "Meta Ad Account ID must contain numbers only. You may paste it with or without the act_ prefix.",
        };
      }

      const existingConnection =
        await db.metaMarketingConnection.findUnique({
          where: {
            shop: session.shop,
          },
        });

      if (
        !submittedToken &&
        !existingConnection?.accessTokenCipher
      ) {
        return {
          success: false,
          message:
            "Enter a Meta Marketing API access token.",
        };
      }

      const accessTokenCipher =
        submittedToken
          ? encryptSecret(submittedToken)
          : existingConnection!
              .accessTokenCipher;

      let accessToken: string;

      try {
        accessToken = submittedToken
          ? submittedToken
          : isEncryptedSecret(
                accessTokenCipher,
              )
            ? decryptSecret(
                accessTokenCipher,
              )
            : accessTokenCipher;
      } catch {
        return {
          success: false,
          message:
            "The saved Marketing API token could not be decrypted. Enter a new token.",
        };
      }

      const apiVersion =
        process.env.META_GRAPH_API_VERSION ??
        "v25.0";

      const accountUrl = new URL(
        `https://graph.facebook.com/${apiVersion}/act_${encodeURIComponent(
          adAccountId,
        )}`,
      );

      accountUrl.searchParams.set(
        "fields",
        "id,account_id,name,account_status,currency",
      );

      accountUrl.searchParams.set(
        "access_token",
        accessToken,
      );

      let verified = false;
      let accountName: string | null = null;
      let verificationError: string | null =
        null;

      try {
        const response = await fetch(
          accountUrl,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
            },
          },
        );

        const responseBody =
          (await response.json()) as {
            id?: string;
            account_id?: string;
            name?: string;
            error?: {
              message?: string;
              code?: number;
              error_subcode?: number;
            };
          };

        if (
          response.ok &&
          !responseBody.error
        ) {
          verified = true;
          accountName =
            responseBody.name ??
            `Ad Account ${adAccountId}`;
        } else {
          verificationError =
            responseBody.error?.message ??
            "Meta could not verify this ad account and token.";
        }
      } catch (error) {
        verificationError =
          error instanceof Error
            ? error.message
            : "Meta account verification failed.";
      }

      await db.metaMarketingConnection.upsert({
        where: {
          shop: session.shop,
        },
        create: {
          shop: session.shop,
          adAccountId,
          businessId,
          accessTokenCipher,
          enabled: true,
          verified,
          accountName,
          lastVerifiedAt: new Date(),
          verificationError,
        },
        update: {
          adAccountId,
          businessId,
          accessTokenCipher,
          enabled: true,
          verified,
          accountName,
          lastVerifiedAt: new Date(),
          verificationError,
        },
      });

      return verified
        ? {
            success: true,
            message:
              "Meta Marketing API connection verified and saved.",
          }
        : {
            success: false,
            message:
              verificationError ??
              "Meta Marketing API connection could not be verified.",
          };
    }

    if (intent === "destination_create") {
      const name = String(
        formData.get("destinationName") ??
          "Meta Pixel",
      ).trim();

      const pixelId = String(
        formData.get("destinationPixelId") ??
          "",
      ).trim();

      const accessToken = String(
        formData.get(
          "destinationAccessToken",
        ) ?? "",
      ).trim();

      const submittedMode = String(
        formData.get("destinationMode") ??
          "PRODUCTION",
      );

      const mode =
        submittedMode === "TEST"
          ? "TEST"
          : "PRODUCTION";

      const testEventCode =
        mode === "TEST"
          ? String(
              formData.get(
                "destinationTestEventCode",
              ) ?? "",
            ).trim() || null
          : null;

      if (!name) {
        return {
          success: false,
          message:
            "Enter a name for the Meta destination.",
        };
      }

      if (!/^\d+$/.test(pixelId)) {
        return {
          success: false,
          message:
            "Meta Pixel ID must contain numbers only.",
        };
      }

      if (!accessToken) {
        return {
          success: false,
          message:
            "Enter a Conversions API access token.",
        };
      }

      await db.metaDestination.create({
        data: {
          shop: session.shop,
          name,
          pixelId,
          accessTokenCipher:
            encryptSecret(accessToken),
          testEventCode,
          mode,
          enabled: true,
          isPrimary: false,
          browserTracking: false,
          serverTracking: true,
        },
      });

      return {
        success: true,
        message:
          "Secondary Meta destination added.",
      };
    }

    if (intent === "destination_update") {
      const destinationId = String(
        formData.get("destinationId") ?? "",
      );

      const existingDestination =
        await db.metaDestination.findFirst({
          where: {
            id: destinationId,
            shop: session.shop,
          },
        });

      if (!existingDestination) {
        return {
          success: false,
          message:
            "Meta destination was not found.",
        };
      }

      const name = String(
        formData.get("destinationName") ??
          "",
      ).trim();

      const pixelId = String(
        formData.get("destinationPixelId") ??
          "",
      ).trim();

      const submittedToken = String(
        formData.get(
          "destinationAccessToken",
        ) ?? "",
      ).trim();

      const submittedMode = String(
        formData.get("destinationMode") ??
          "PRODUCTION",
      );

      const mode =
        submittedMode === "TEST"
          ? "TEST"
          : "PRODUCTION";

      const testEventCode =
        mode === "TEST"
          ? String(
              formData.get(
                "destinationTestEventCode",
              ) ?? "",
            ).trim() || null
          : null;

      if (!name) {
        return {
          success: false,
          message:
            "Enter a name for the Meta destination.",
        };
      }

      if (!/^\d+$/.test(pixelId)) {
        return {
          success: false,
          message:
            "Meta Pixel ID must contain numbers only.",
        };
      }

      const accessTokenCipher =
        submittedToken
          ? encryptSecret(submittedToken)
          : existingDestination.accessTokenCipher;

      await db.metaDestination.update({
        where: {
          id: existingDestination.id,
        },
        data: {
          name,
          pixelId,
          accessTokenCipher,
          mode,
          testEventCode,
          serverTracking: true,
          browserTracking:
            existingDestination.isPrimary,
        },
      });

      if (existingDestination.isPrimary) {
        const settings =
          await db.pixelSettings.findUnique({
            where: {
              shop: session.shop,
            },
          });

        await db.pixelSettings.update({
          where: {
            shop: session.shop,
          },
          data: {
            metaPixelId: pixelId,
            metaAccessTokenCipher:
              accessTokenCipher,
            metaMode: mode,
            metaTestEventCode:
              testEventCode,
          },
        });

        const webPixelSettings = {
          pixel_id: pixelId,
          shop_domain: session.shop,
          tracking_enabled: String(
            settings?.trackingEnabled ??
              true,
          ),
          browser_tracking: String(
            settings?.browserTracking ??
              true,
          ),
        };

        const existingWebPixel =
          await getCurrentWebPixel(admin);

        if (existingWebPixel) {
          await updateWebPixel(
            admin,
            existingWebPixel.id,
            webPixelSettings,
          );
        } else {
          await createWebPixel(
            admin,
            webPixelSettings,
          );
        }
      }

      return {
        success: true,
        message:
          "Meta destination updated.",
      };
    }

    if (intent === "destination_toggle") {
      const destinationId = String(
        formData.get("destinationId") ?? "",
      );

      const destination =
        await db.metaDestination.findFirst({
          where: {
            id: destinationId,
            shop: session.shop,
          },
        });

      if (!destination) {
        return {
          success: false,
          message:
            "Meta destination was not found.",
        };
      }

      if (
        destination.isPrimary &&
        destination.enabled
      ) {
        return {
          success: false,
          message:
            "The primary destination cannot be disabled. Set another destination as primary first.",
        };
      }

      await db.metaDestination.update({
        where: {
          id: destination.id,
        },
        data: {
          enabled: !destination.enabled,
        },
      });

      return {
        success: true,
        message: destination.enabled
          ? "Meta destination disabled."
          : "Meta destination enabled.",
      };
    }

    if (intent === "destination_primary") {
      const destinationId = String(
        formData.get("destinationId") ?? "",
      );

      const destination =
        await db.metaDestination.findFirst({
          where: {
            id: destinationId,
            shop: session.shop,
          },
        });

      if (!destination) {
        return {
          success: false,
          message:
            "Meta destination was not found.",
        };
      }

      await db.$transaction([
        db.metaDestination.updateMany({
          where: {
            shop: session.shop,
          },
          data: {
            isPrimary: false,
            browserTracking: false,
          },
        }),
        db.metaDestination.update({
          where: {
            id: destination.id,
          },
          data: {
            isPrimary: true,
            enabled: true,
            browserTracking: true,
            serverTracking: true,
          },
        }),
        db.pixelSettings.update({
          where: {
            shop: session.shop,
          },
          data: {
            metaPixelId:
              destination.pixelId,
            metaAccessTokenCipher:
              destination.accessTokenCipher,
            metaMode: destination.mode,
            metaTestEventCode:
              destination.mode === "TEST"
                ? destination.testEventCode
                : null,
          },
        }),
      ]);

      const settings =
        await db.pixelSettings.findUnique({
          where: {
            shop: session.shop,
          },
        });

      const webPixelSettings = {
        pixel_id: destination.pixelId,
        shop_domain: session.shop,
        tracking_enabled: String(
          settings?.trackingEnabled ?? true,
        ),
        browser_tracking: String(
          settings?.browserTracking ?? true,
        ),
      };

      const existingWebPixel =
        await getCurrentWebPixel(admin);

      if (existingWebPixel) {
        await updateWebPixel(
          admin,
          existingWebPixel.id,
          webPixelSettings,
        );
      } else {
        await createWebPixel(
          admin,
          webPixelSettings,
        );
      }

      return {
        success: true,
        message:
          "Primary Meta destination changed and Shopify Web Pixel synchronized.",
      };
    }

    if (intent === "destination_delete") {
      const destinationId = String(
        formData.get("destinationId") ?? "",
      );

      const destination =
        await db.metaDestination.findFirst({
          where: {
            id: destinationId,
            shop: session.shop,
          },
        });

      if (!destination) {
        return {
          success: false,
          message:
            "Meta destination was not found.",
        };
      }

      if (destination.isPrimary) {
        return {
          success: false,
          message:
            "The primary destination cannot be deleted. Set another destination as primary first.",
        };
      }

      await db.metaDestination.delete({
        where: {
          id: destination.id,
        },
      });

      return {
        success: true,
        message:
          "Meta destination removed.",
      };
    }

    const metaPixelId = String(
      formData.get("metaPixelId") ?? "",
    ).trim();

    const submittedAccessToken = String(
      formData.get("metaAccessToken") ?? "",
    ).trim();

    const metaTestEventCode = String(
      formData.get("metaTestEventCode") ?? "",
    ).trim();

    const submittedMetaMode = String(
      formData.get("metaMode") ?? "TEST",
    ).trim();

    const metaMode =
      submittedMetaMode === "PRODUCTION"
        ? "PRODUCTION"
        : "TEST";

    const savedTestEventCode =
      metaMode === "TEST"
        ? metaTestEventCode || null
        : null;

    const trackingEnabled =
      formData.get("trackingEnabled") === "on";

    const browserTracking =
      formData.get("browserTracking") === "on";

    const serverTracking =
      formData.get("serverTracking") === "on";

    if (trackingEnabled && !metaPixelId) {
      return {
        success: false,
        message:
          "Enter a Meta Pixel ID before enabling tracking.",
      };
    }

    if (
      metaPixelId &&
      !/^\d+$/.test(metaPixelId)
    ) {
      return {
        success: false,
        message:
          "Meta Pixel ID must contain numbers only.",
      };
    }

    const existingSettings =
      await db.pixelSettings.findUnique({
        where: {
          shop: session.shop,
        },
      });

    if (
      serverTracking &&
      !submittedAccessToken &&
      !existingSettings?.metaAccessTokenCipher
    ) {
      return {
        success: false,
        message:
          "Enter a Conversions API access token before enabling server-side tracking.",
      };
    }

    let encryptedAccessToken:
      | string
      | null = null;

    if (submittedAccessToken) {
      encryptedAccessToken =
        encryptSecret(submittedAccessToken);
    } else if (
      existingSettings?.metaAccessTokenCipher
    ) {
      encryptedAccessToken =
        isEncryptedSecret(
          existingSettings.metaAccessTokenCipher,
        )
          ? existingSettings.metaAccessTokenCipher
          : encryptSecret(
              existingSettings.metaAccessTokenCipher,
            );
    }

    await db.pixelSettings.upsert({
      where: {
        shop: session.shop,
      },
      create: {
        shop: session.shop,
        metaPixelId:
          metaPixelId || null,
        metaAccessTokenCipher:
          encryptedAccessToken,
        metaTestEventCode:
          savedTestEventCode,
        metaMode,
        trackingEnabled,
        browserTracking,
        serverTracking,
      },
      update: {
        metaPixelId:
          metaPixelId || null,
        metaAccessTokenCipher:
          encryptedAccessToken,
        metaTestEventCode:
          savedTestEventCode,
        metaMode,
        trackingEnabled,
        browserTracking,
        serverTracking,
      },
    });

    if (
      metaPixelId &&
      encryptedAccessToken
    ) {
      const currentPrimary =
        await db.metaDestination.findFirst({
          where: {
            shop: session.shop,
            isPrimary: true,
          },
        });

      if (currentPrimary) {
        await db.metaDestination.update({
          where: {
            id: currentPrimary.id,
          },
          data: {
            name:
              currentPrimary.name ||
              "Primary Meta Pixel",
            pixelId: metaPixelId,
            accessTokenCipher:
              encryptedAccessToken,
            testEventCode:
              savedTestEventCode,
            mode: metaMode,
            enabled: trackingEnabled,
            browserTracking,
            serverTracking,
          },
        });
      } else {
        await db.metaDestination.create({
          data: {
            shop: session.shop,
            name: "Primary Meta Pixel",
            pixelId: metaPixelId,
            accessTokenCipher:
              encryptedAccessToken,
            testEventCode:
              savedTestEventCode,
            mode: metaMode,
            enabled: trackingEnabled,
            isPrimary: true,
            browserTracking,
            serverTracking,
          },
        });
      }
    }

    const webPixelSettings = {
      pixel_id: metaPixelId,
      shop_domain: session.shop,
      tracking_enabled:
        String(trackingEnabled),
      browser_tracking:
        String(browserTracking),
    };

    const existingWebPixel =
      await getCurrentWebPixel(admin);

    const synchronizedWebPixel =
      existingWebPixel
        ? await updateWebPixel(
            admin,
            existingWebPixel.id,
            webPixelSettings,
          )
        : await createWebPixel(
            admin,
            webPixelSettings,
          );

    return {
      success: true,
      message: existingWebPixel
        ? "Settings saved, primary destination synchronized, and Shopify Web Pixel updated."
        : "Settings saved, primary destination synchronized, and Shopify Web Pixel created.",
      webPixelId: synchronizedWebPixel.id,
    };
  } catch (error) {
    console.error(
      "Meta settings action failed",
      {
        intent,
        error,
      },
    );

    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "The requested Meta settings change could not be completed.",
    };
  }
};
export default function Index() {
  const {
    shop,
    settings,
    webPixel,
    destinations,
    marketingConnection,
    audiences,
    diagnostics,
  } = useLoaderData<typeof loader>();

  const actionData =
    useActionData<typeof action>();

  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [
    metaMode,
    setMetaMode,
  ] = useState(settings.metaMode);

  const [
    trackingEnabled,
    setTrackingEnabled,
  ] = useState(settings.trackingEnabled);

  const [
    browserTracking,
    setBrowserTracking,
  ] = useState(settings.browserTracking);

  const [
    serverTracking,
    setServerTracking,
  ] = useState(settings.serverTracking);

  const isSaving =
    navigation.state === "submitting" &&
    navigation.formMethod?.toUpperCase() ===
      "POST";

  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show(actionData.message);
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Meta Pixel Tracking">
      <s-section heading="Delivery dashboard">
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Server-side Meta delivery results for{" "}
            {diagnostics.windowLabel.toLowerCase()}.
          </s-paragraph>

          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(150px, 1fr))",
              gap: "12px",
            }}
          >
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-text>Events attempted</s-text>
                <s-heading>
                  {diagnostics.attemptedCount}
                </s-heading>
              </s-stack>
            </s-box>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-text>Delivered</s-text>
                <s-heading>
                  {diagnostics.deliveredCount}
                </s-heading>
              </s-stack>
            </s-box>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-text>Rejected</s-text>
                <s-heading>
                  {diagnostics.rejectedCount}
                </s-heading>
              </s-stack>
            </s-box>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-text>Failed</s-text>
                <s-heading>
                  {diagnostics.failedCount}
                </s-heading>
              </s-stack>
            </s-box>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-text>Delayed over 5 min</s-text>
                <s-heading>
                  {diagnostics.delayedCount}
                </s-heading>
              </s-stack>
            </s-box>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-text>Acceptance rate</s-text>
                <s-heading>
                  {diagnostics.acceptanceRate}%
                </s-heading>
              </s-stack>
            </s-box>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-text>Last delivery</s-text>
                <s-text>
                  {diagnostics.lastDelivered
                    ? `${diagnostics.lastDelivered.eventName} — ${new Date(
                        diagnostics.lastDelivered.deliveredAt ??
                          "",
                      ).toLocaleString()}`
                    : "No successful delivery yet"}
                </s-text>
              </s-stack>
            </s-box>
          </div>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack
              direction="block"
              gap="base"
            >
              <s-heading>
                Destination health
              </s-heading>

              <div
                style={{
                  overflowX: "auto",
                }}
              >
                <table
                  style={{
                    width: "100%",
                    minWidth: "860px",
                    borderCollapse: "collapse",
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "8px" }}>
                        Destination
                      </th>
                      <th style={{ textAlign: "left", padding: "8px" }}>
                        Health
                      </th>
                      <th style={{ textAlign: "right", padding: "8px" }}>
                        Attempted
                      </th>
                      <th style={{ textAlign: "right", padding: "8px" }}>
                        Delivered
                      </th>
                      <th style={{ textAlign: "right", padding: "8px" }}>
                        Rejected
                      </th>
                      <th style={{ textAlign: "right", padding: "8px" }}>
                        Failed
                      </th>
                      <th style={{ textAlign: "right", padding: "8px" }}>
                        Rate
                      </th>
                      <th style={{ textAlign: "left", padding: "8px" }}>
                        Last delivery
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {diagnostics.destinationDiagnostics.map(
                      (destination) => (
                        <tr key={destination.id}>
                          <td
                            style={{
                              padding: "8px",
                              borderTop:
                                "1px solid #e1e3e5",
                            }}
                          >
                            <strong>
                              {destination.name}
                            </strong>
                            <div>
                              {destination.pixelId}
                              {destination.isPrimary
                                ? " · Primary"
                                : ""}
                            </div>
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderTop:
                                "1px solid #e1e3e5",
                            }}
                          >
                            {destination.health}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              borderTop:
                                "1px solid #e1e3e5",
                            }}
                          >
                            {destination.attempted}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              borderTop:
                                "1px solid #e1e3e5",
                            }}
                          >
                            {destination.delivered}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              borderTop:
                                "1px solid #e1e3e5",
                            }}
                          >
                            {destination.rejected}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              borderTop:
                                "1px solid #e1e3e5",
                            }}
                          >
                            {destination.failed}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              borderTop:
                                "1px solid #e1e3e5",
                            }}
                          >
                            {destination.acceptanceRate}%
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderTop:
                                "1px solid #e1e3e5",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {destination.lastDelivery
                              ? `${destination.lastDelivery.eventName} — ${new Date(
                                  destination.lastDelivery.deliveredAt ??
                                    "",
                                ).toLocaleString()}`
                              : "—"}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack
              direction="block"
              gap="base"
            >
              <s-heading>Event totals</s-heading>

              {diagnostics.eventTotals.length ? (
                <div
                  style={{
                    overflowX: "auto",
                  }}
                >
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                    }}
                  >
                    <thead>
                      <tr>
                        <th
                          style={{
                            textAlign: "left",
                            padding: "8px",
                          }}
                        >
                          Event
                        </th>
                        <th
                          style={{
                            textAlign: "right",
                            padding: "8px",
                          }}
                        >
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnostics.eventTotals.map(
                        (event) => (
                          <tr key={event.eventName}>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.eventName}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                textAlign: "right",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.count}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <s-text>
                  No events recorded in this period.
                </s-text>
              )}
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack
              direction="block"
              gap="base"
            >
              <s-heading>Recent deliveries</s-heading>

              {diagnostics.recentEvents.length ? (
                <div
                  style={{
                    overflowX: "auto",
                  }}
                >
                  <table
                    style={{
                      width: "100%",
                      minWidth: "760px",
                      borderCollapse: "collapse",
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Time
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Pixel
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Event
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Status
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Timing
                        </th>
                        <th style={{ textAlign: "right", padding: "8px" }}>
                          HTTP
                        </th>
                        <th style={{ textAlign: "right", padding: "8px" }}>
                          Received
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Mode
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Error
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnostics.recentEvents.map(
                        (event) => (
                          <tr key={event.id}>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {new Date(
                                event.createdAt,
                              ).toLocaleString()}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {event.pixelId}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                              title={event.eventId}
                            >
                              {event.eventName}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.status}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.delayed
                                ? "Delayed"
                                : "Normal"}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                textAlign: "right",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.httpStatus ?? "—"}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                textAlign: "right",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.eventsReceived ??
                                "—"}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.testMode
                                ? "Test"
                                : "Production"}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                                maxWidth: "260px",
                              }}
                            >
                              {event.errorMessage ?? "—"}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <s-text>
                  No delivery records exist yet.
                </s-text>
              )}
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack
              direction="block"
              gap="base"
            >
              <s-heading>
                Recent failures
              </s-heading>

              {diagnostics.recentFailures.length ? (
                <div
                  style={{
                    overflowX: "auto",
                  }}
                >
                  <table
                    style={{
                      width: "100%",
                      minWidth: "720px",
                      borderCollapse: "collapse",
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Time
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Pixel
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Event
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Status
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Error
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnostics.recentFailures.map(
                        (event) => (
                          <tr key={event.id}>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {new Date(
                                event.createdAt,
                              ).toLocaleString()}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.pixelId}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.eventName}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {event.status}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                                maxWidth: "360px",
                              }}
                            >
                              {event.errorMessage ??
                                "Unknown error"}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <s-text>
                  No recent destination failures.
                </s-text>
              )}
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <Form method="post">
        <input
          type="hidden"
          name="intent"
          value="save_settings"
        />

        <s-section heading="Store">
          <s-stack
            direction="block"
            gap="base"
          >
            <s-paragraph>
              Configure browser and server-side
              Meta tracking for this Shopify store.
            </s-paragraph>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-text>
                  <strong>
                    Connected store
                  </strong>
                </s-text>

                <s-text>{shop}</s-text>
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>

        {actionData &&
          !actionData.success && (
            <s-section>
              <s-banner tone="critical">
                <s-paragraph>
                  {actionData.message}
                </s-paragraph>
              </s-banner>
            </s-section>
          )}

        <s-section heading="Meta configuration">
          <s-stack
            direction="block"
            gap="base"
          >
            <s-text-field
              label="Meta Pixel ID"
              name="metaPixelId"
              value={
                settings.metaPixelId
              }
              placeholder="123456789012345"
              helpText="Enter the numeric Pixel or Dataset ID assigned to this store."
              autoComplete="off"
            />

            <s-text-field
              label="Conversions API access token"
              name="metaAccessToken"
              type="password"
              placeholder={
                settings.hasAccessToken
                  ? "Token already saved — leave blank to keep it"
                  : "Enter Meta access token"
              }
              helpText={
                settings.hasAccessToken
                  ? "An encrypted access token is stored. Enter a new token only to replace it."
                  : "The token will be encrypted before it is stored."
              }
              autoComplete="new-password"
            />

            <label>
              <span>
                <strong>Meta mode</strong>
              </span>

              <select
                name="metaMode"
                value={metaMode}
                onChange={(event) =>
                  setMetaMode(
                    event.currentTarget.value,
                  )
                }
              >
                <option value="TEST">
                  Test
                </option>

                <option value="PRODUCTION">
                  Production
                </option>
              </select>
            </label>

            {metaMode === "TEST" ? (
              <s-text-field
                label="Meta test event code"
                name="metaTestEventCode"
                value={
                  settings.metaTestEventCode
                }
                placeholder="TEST57130"
                helpText="Events will appear in Meta Test Events."
                autoComplete="off"
              />
            ) : (
              <s-banner tone="info">
                <s-paragraph>
                  Production mode is active. Any saved
                  Meta test event code will be removed
                  when settings are saved.
                </s-paragraph>
              </s-banner>
            )}
          </s-stack>
        </s-section>

        <s-section heading="Tracking options">
          <s-stack
            direction="block"
            gap="base"
          >
            <label>
              <input
                type="checkbox"
                name="trackingEnabled"
                checked={trackingEnabled}
                onChange={(event) =>
                  setTrackingEnabled(
                    event.currentTarget.checked,
                  )
                }
              />{" "}
              Enable Meta tracking
            </label>

            <label>
              <input
                type="checkbox"
                name="browserTracking"
                checked={browserTracking}
                onChange={(event) =>
                  setBrowserTracking(
                    event.currentTarget.checked,
                  )
                }
              />{" "}
              Enable browser-side Meta Pixel
              events
            </label>

            <label>
              <input
                type="checkbox"
                name="serverTracking"
                checked={serverTracking}
                onChange={(event) =>
                  setServerTracking(
                    event.currentTarget.checked,
                  )
                }
              />{" "}
              Enable server-side Conversions API
              events
            </label>
          </s-stack>
        </s-section>

        <s-section heading="Events">
          <s-unordered-list>
            <s-list-item>
              PageView
            </s-list-item>

            <s-list-item>
              ViewContent
            </s-list-item>

            <s-list-item>
              AddToCart
            </s-list-item>

            <s-list-item>
              InitiateCheckout
            </s-list-item>

            <s-list-item>
              Purchase
            </s-list-item>
          </s-unordered-list>
        </s-section>

        <s-section>
          <s-button
            type="submit"
            variant="primary"
            {...(isSaving
              ? { loading: true }
              : {})}
          >
            Save settings
          </s-button>
        </s-section>
      </Form>

      <s-section heading="Meta destinations">
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            The primary destination receives both
            browser and server events. Additional
            destinations receive independent
            server-side Conversions API deliveries.
          </s-paragraph>

          {destinations.map((destination) => (
            <s-box
              key={destination.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="destination_update"
                />
                <input
                  type="hidden"
                  name="destinationId"
                  value={destination.id}
                />

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(210px, 1fr))",
                    gap: "12px",
                  }}
                >
                  <label>
                    <strong>
                      Destination name
                    </strong>
                    <input
                      name="destinationName"
                      defaultValue={
                        destination.name
                      }
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>

                  <label>
                    <strong>
                      Meta Pixel ID
                    </strong>
                    <input
                      name="destinationPixelId"
                      defaultValue={
                        destination.pixelId
                      }
                      inputMode="numeric"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>

                  <label>
                    <strong>
                      Replace access token
                    </strong>
                    <input
                      name="destinationAccessToken"
                      type="password"
                      placeholder={
                        destination.hasAccessToken
                          ? "Token saved — leave blank to keep it"
                          : "Enter access token"
                      }
                      autoComplete="new-password"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>

                  <label>
                    <strong>Mode</strong>
                    <select
                      name="destinationMode"
                      defaultValue={
                        destination.mode
                      }
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    >
                      <option value="PRODUCTION">
                        Production
                      </option>
                      <option value="TEST">
                        Test
                      </option>
                    </select>
                  </label>

                  <label>
                    <strong>
                      Test event code
                    </strong>
                    <input
                      name="destinationTestEventCode"
                      defaultValue={
                        destination.testEventCode
                      }
                      placeholder="Used only in Test mode"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "8px",
                    marginTop: "14px",
                    alignItems: "center",
                  }}
                >
                  <s-button
                    type="submit"
                    variant="primary"
                  >
                    Save destination
                  </s-button>

                  <s-text>
                    {destination.isPrimary
                      ? "Primary"
                      : "Secondary"}{" "}
                    ·{" "}
                    {destination.enabled
                      ? "Enabled"
                      : "Disabled"}{" "}
                    · Server{" "}
                    {destination.serverTracking
                      ? "on"
                      : "off"}
                  </s-text>
                </div>
              </Form>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "8px",
                  marginTop: "10px",
                }}
              >
                {!destination.isPrimary && (
                  <>
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="destination_primary"
                      />
                      <input
                        type="hidden"
                        name="destinationId"
                        value={destination.id}
                      />
                      <s-button type="submit">
                        Set as primary
                      </s-button>
                    </Form>

                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="destination_toggle"
                      />
                      <input
                        type="hidden"
                        name="destinationId"
                        value={destination.id}
                      />
                      <s-button type="submit">
                        {destination.enabled
                          ? "Disable"
                          : "Enable"}
                      </s-button>
                    </Form>

                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="destination_delete"
                      />
                      <input
                        type="hidden"
                        name="destinationId"
                        value={destination.id}
                      />
                      <s-button
                        type="submit"
                        tone="critical"
                      >
                        Remove
                      </s-button>
                    </Form>
                  </>
                )}
              </div>
            </s-box>
          ))}

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="destination_create"
              />

              <s-stack
                direction="block"
                gap="base"
              >
                <s-heading>
                  Add secondary destination
                </s-heading>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(210px, 1fr))",
                    gap: "12px",
                  }}
                >
                  <label>
                    <strong>
                      Destination name
                    </strong>
                    <input
                      name="destinationName"
                      placeholder="Retargeting Pixel"
                      required
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>

                  <label>
                    <strong>
                      Meta Pixel ID
                    </strong>
                    <input
                      name="destinationPixelId"
                      placeholder="123456789012345"
                      inputMode="numeric"
                      required
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>

                  <label>
                    <strong>
                      Conversions API token
                    </strong>
                    <input
                      name="destinationAccessToken"
                      type="password"
                      required
                      autoComplete="new-password"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>

                  <label>
                    <strong>Mode</strong>
                    <select
                      name="destinationMode"
                      defaultValue="PRODUCTION"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    >
                      <option value="PRODUCTION">
                        Production
                      </option>
                      <option value="TEST">
                        Test
                      </option>
                    </select>
                  </label>

                  <label>
                    <strong>
                      Test event code
                    </strong>
                    <input
                      name="destinationTestEventCode"
                      placeholder="Optional in Test mode"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>
                </div>

                <s-button
                  type="submit"
                  variant="primary"
                >
                  Add destination
                </s-button>
              </s-stack>
            </Form>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Meta Marketing API">
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Connect the Meta ad account used for
            customer-file Custom Audiences and
            lookalike audiences. This token is
            stored separately from the
            Conversions API token.
          </s-paragraph>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="marketing_connection_save"
              />

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "12px",
                }}
              >
                <label>
                  <strong>
                    Meta Ad Account ID
                  </strong>
                  <input
                    name="adAccountId"
                    defaultValue={
                      marketingConnection?.adAccountId ??
                      ""
                    }
                    placeholder="act_123456789012345"
                    inputMode="numeric"
                    required
                    style={{
                      display: "block",
                      width: "100%",
                      marginTop: "6px",
                      padding: "8px",
                    }}
                  />
                </label>

                <label>
                  <strong>
                    Meta Business ID
                  </strong>
                  <input
                    name="businessId"
                    defaultValue={
                      marketingConnection?.businessId ??
                      ""
                    }
                    placeholder="Optional"
                    inputMode="numeric"
                    style={{
                      display: "block",
                      width: "100%",
                      marginTop: "6px",
                      padding: "8px",
                    }}
                  />
                </label>

                <label>
                  <strong>
                    Marketing API access token
                  </strong>
                  <input
                    name="marketingAccessToken"
                    type="password"
                    placeholder={
                      marketingConnection?.hasAccessToken
                        ? "Token saved — leave blank to keep it"
                        : "Enter token with ads_management"
                    }
                    autoComplete="new-password"
                    style={{
                      display: "block",
                      width: "100%",
                      marginTop: "6px",
                      padding: "8px",
                    }}
                  />
                </label>
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "10px",
                  alignItems: "center",
                  marginTop: "14px",
                }}
              >
                <s-button
                  type="submit"
                  variant="primary"
                >
                  Save and verify connection
                </s-button>

                <s-text>
                  Status:{" "}
                  {marketingConnection?.verified
                    ? "Verified"
                    : marketingConnection
                      ? "Not verified"
                      : "Not connected"}
                </s-text>
              </div>
            </Form>

            {marketingConnection && (
              <div
                style={{
                  marginTop: "14px",
                }}
              >
                <s-stack
                  direction="block"
                  gap="small"
                >
                  {marketingConnection.accountName && (
                    <s-text>
                      Account:{" "}
                      {marketingConnection.accountName}
                    </s-text>
                  )}

                  <s-text>
                    Token security:{" "}
                    {marketingConnection.accessTokenEncrypted
                      ? "Encrypted"
                      : "Pending encryption"}
                  </s-text>

                  <s-text>
                    Last verification:{" "}
                    {marketingConnection.lastVerifiedAt
                      ? new Date(
                          marketingConnection.lastVerifiedAt,
                        ).toLocaleString()
                      : "Never"}
                  </s-text>

                  {marketingConnection.verificationError && (
                    <s-banner tone="critical">
                      <s-paragraph>
                        {
                          marketingConnection.verificationError
                        }
                      </s-paragraph>
                    </s-banner>
                  )}
                </s-stack>
              </div>
            )}
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="audience_create_customer_file"
              />

              <s-stack
                direction="block"
                gap="base"
              >
                <s-heading>
                  Create customer-file audience
                </s-heading>

                <s-paragraph>
                  Includes Shopify customers whose
                  email or SMS marketing state is
                  Subscribed. Identifiers are
                  normalized and SHA-256 hashed
                  before transmission. Raw customer
                  information is not stored by this
                  app.
                </s-paragraph>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(240px, 1fr))",
                    gap: "12px",
                  }}
                >
                  <label>
                    <strong>
                      Audience name
                    </strong>
                    <input
                      name="audienceName"
                      placeholder="Carpathian Wool Subscribers"
                      required
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>

                  <label>
                    <strong>
                      Description
                    </strong>
                    <input
                      name="audienceDescription"
                      placeholder="Subscribed Shopify customers"
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: "6px",
                        padding: "8px",
                      }}
                    />
                  </label>
                </div>

                <label>
                  <input
                    type="checkbox"
                    name="audienceTermsConfirmed"
                    required
                  />{" "}
                  I confirm that this customer
                  information may be used for
                  advertising and that the Meta
                  Custom Audience terms have been
                  accepted for this ad account.
                </label>

                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSaving
                    ? { loading: true }
                    : {})}
                >
                  Create and upload audience
                </s-button>
              </s-stack>
            </Form>
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack
              direction="block"
              gap="base"
            >
              <s-heading>
                Audience records
              </s-heading>

              {audiences.length ? (
                <div
                  style={{
                    overflowX: "auto",
                  }}
                >
                  <table
                    style={{
                      width: "100%",
                      minWidth: "720px",
                      borderCollapse: "collapse",
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Name
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Meta ID
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Type
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Status
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Operation
                        </th>
                        <th style={{ textAlign: "right", padding: "8px" }}>
                          Customers
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Last sync
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {audiences.map(
                        (audience) => (
                          <tr key={audience.id}>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {audience.name}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {audience.metaAudienceId ||
                                "—"}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {audience.audienceType}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {audience.status}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                                minWidth: "320px",
                                whiteSpace: "normal",
                                overflowWrap: "anywhere",
                              }}
                            >
                              <strong>
                                {audience.operationStatus ||
                                  "—"}
                              </strong>

                              {audience.errorMessage && (
                                <div
                                  style={{
                                    marginTop: "4px",
                                  }}
                                >
                                  {
                                    audience.errorMessage
                                  }
                                </div>
                              )}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                textAlign: "right",
                                borderTop:
                                  "1px solid #e1e3e5",
                              }}
                            >
                              {audience.customerCount ??
                                "—"}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {audience.lastSyncedAt
                                ? new Date(
                                    audience.lastSyncedAt,
                                  ).toLocaleString()
                                : "—"}
                            </td>

                            <td
                              style={{
                                padding: "8px",
                                borderTop:
                                  "1px solid #e1e3e5",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {audience.metaAudienceId ? (
                                <Form method="post">
                                  <input
                                    type="hidden"
                                    name="intent"
                                    value="audience_refresh_customer_file"
                                  />
                                  <input
                                    type="hidden"
                                    name="audienceId"
                                    value={audience.id}
                                  />

                                  <s-button
                                    type="submit"
                                    {...(isSaving
                                      ? {
                                          loading:
                                            true,
                                        }
                                      : {})}
                                  >
                                    Refresh audience
                                  </s-button>
                                </Form>
                              ) : (
                                <s-text>
                                  Not available
                                </s-text>
                              )}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <s-text>
                  No audience records yet. Connect
                  and verify the ad account first.
                </s-text>
              )}
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section
        slot="aside"
        heading="Current status"
      >
        <s-stack
          direction="block"
          gap="small"
        >
          <s-text>
            Meta mode:{" "}
            {metaMode === "PRODUCTION"
              ? "Production"
              : "Test"}
          </s-text>

          <s-text>
            Tracking:{" "}
            {trackingEnabled
              ? "Enabled"
              : "Disabled"}
          </s-text>

          <s-text>
            Browser events:{" "}
            {browserTracking
              ? "Enabled"
              : "Disabled"}
          </s-text>

          <s-text>
            Server events:{" "}
            {serverTracking
              ? "Enabled"
              : "Disabled"}
          </s-text>

          <s-text>
            Access token:{" "}
            {settings.hasAccessToken
              ? "Saved"
              : "Not configured"}
          </s-text>

          <s-text>
            Token security:{" "}
            {settings.accessTokenEncrypted
              ? "Encrypted"
              : settings.hasAccessToken
                ? "Pending encryption"
                : "Not applicable"}
          </s-text>

          <s-text>
            Shopify Web Pixel:{" "}
            {webPixel
              ? "Connected"
              : "Not connected"}
          </s-text>

          {webPixel && (
            <s-text>
              Web Pixel ID: {webPixel.id}
            </s-text>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (
  headersArgs,
) => {
  return boundary.headers(headersArgs);
};