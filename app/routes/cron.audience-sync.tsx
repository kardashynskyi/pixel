import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";

import db from "../db.server";
import {
  decryptSecret,
  isEncryptedSecret,
} from "../encryption.server";
import { unauthenticated } from "../shopify.server";

type AdminClient = Awaited<
  ReturnType<typeof unauthenticated.admin>
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

type MetaAudienceReplaceResponse =
  MetaApiError & {
    audience_id?: string;
    num_received?: number;
    num_invalid_entries?: number;
    session_id?: string;
  };

type SyncResult = {
  audienceId: string;
  metaAudienceId: string;
  shop: string;
  status:
    | "REFRESHED"
    | "WAITING_FOR_META"
    | "FAILED"
    | "SKIPPED";
  customerCount?: number;
  identifiersReceived?: number;
  message?: string;
};

class MetaApiRequestError extends Error {
  readonly type: string | null;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly traceId: string | null;
  readonly httpStatus: number | null;

  constructor({
    message,
    type,
    code,
    subcode,
    traceId,
    httpStatus,
  }: {
    message: string;
    type?: string | null;
    code?: number | null;
    subcode?: number | null;
    traceId?: string | null;
    httpStatus?: number | null;
  }) {
    super(message);
    this.name = "MetaApiRequestError";
    this.type = type ?? null;
    this.code = code ?? null;
    this.subcode = subcode ?? null;
    this.traceId = traceId ?? null;
    this.httpStatus = httpStatus ?? null;
  }
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function secureEquals(
  left: string,
  right: string,
): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length ===
      rightBuffer.length &&
    timingSafeEqual(
      leftBuffer,
      rightBuffer,
    )
  );
}

function isAuthorized(
  request: Request,
): boolean {
  const expectedSecret =
    process.env.AUDIENCE_SYNC_SECRET?.trim();

  if (!expectedSecret) {
    return false;
  }

  const authorization =
    request.headers.get("authorization") ??
    "";

  const suppliedSecret =
    authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";

  return (
    suppliedSecret.length > 0 &&
    secureEquals(
      suppliedSecret,
      expectedSecret,
    )
  );
}

function getGraphqlErrors(
  errors:
    | Array<{ message: string }>
    | undefined,
): string | null {
  if (!errors?.length) {
    return null;
  }

  return errors
    .map((error) => error.message)
    .join("; ");
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

  return [
    error.message ?? fallback,
    error.type
      ? `type=${error.type}`
      : null,
    typeof error.code === "number"
      ? `code=${error.code}`
      : null,
    typeof error.error_subcode ===
    "number"
      ? `subcode=${error.error_subcode}`
      : null,
    error.fbtrace_id
      ? `trace=${error.fbtrace_id}`
      : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

function createMetaApiRequestError(
  body: MetaApiError,
  fallback: string,
  httpStatus: number,
): MetaApiRequestError {
  return new MetaApiRequestError({
    message: getMetaErrorMessage(
      body,
      fallback,
    ),
    type: body.error?.type ?? null,
    code:
      typeof body.error?.code ===
      "number"
        ? body.error.code
        : null,
    subcode:
      typeof body.error?.error_subcode ===
      "number"
        ? body.error.error_subcode
        : null,
    traceId:
      body.error?.fbtrace_id ?? null,
    httpStatus,
  });
}

async function getShopifyAudienceIdentifiers(
  admin: AdminClient,
): Promise<{
  customerCount: number;
  emailHashes: string[];
  phoneHashes: string[];
}> {
  const emailHashes =
    new Set<string>();

  const phoneHashes =
    new Set<string>();

  const eligibleCustomerIds =
    new Set<string>();

  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response =
      await admin.graphql(
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

      const email = normalizeEmail(
        customer.defaultEmailAddress
          ?.emailAddress,
      );

      if (
        email &&
        customer.defaultEmailAddress
          ?.validFormat !== false &&
        customer.defaultEmailAddress
          ?.marketingState ===
          "SUBSCRIBED"
      ) {
        emailHashes.add(
          sha256(email),
        );

        included = true;
      }

      const phone = normalizePhone(
        customer.defaultPhoneNumber
          ?.phoneNumber,
      );

      if (
        phone &&
        customer.defaultPhoneNumber
          ?.marketingState ===
          "SUBSCRIBED"
      ) {
        phoneHashes.add(
          sha256(phone),
        );

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
    emailHashes:
      [...emailHashes],
    phoneHashes:
      [...phoneHashes],
  };
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
    Math.floor(
      Math.random() * 1000,
    );

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
      index + 10000 >=
      rows.length;

    const body =
      new URLSearchParams();

    body.set(
      "access_token",
      accessToken,
    );

    body.set(
      "session",
      JSON.stringify({
        session_id: sessionId,
        batch_seq: batchSequence,
        last_batch_flag:
          isLastBatch,
        estimated_num_total:
          rows.length,
      }),
    );

    body.set(
      "payload",
      JSON.stringify({
        schema: [
          "EMAIL",
          "PHONE",
        ],
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
      (await response.json()) as MetaAudienceReplaceResponse;

    if (
      !response.ok ||
      responseBody.error
    ) {
      throw createMetaApiRequestError(
        responseBody,
        "Meta rejected the automatic audience replacement.",
        response.status,
      );
    }

    totalReceived +=
      responseBody.num_received ??
      batch.length;

    batchSequence += 1;
  }

  return totalReceived;
}

async function syncAudience(
  audience: {
    id: string;
    shop: string;
    metaAudienceId: string | null;
  },
): Promise<SyncResult> {
  if (!audience.metaAudienceId) {
    return {
      audienceId: audience.id,
      metaAudienceId: "",
      shop: audience.shop,
      status: "SKIPPED",
      message:
        "Audience has no Meta audience ID.",
    };
  }

  const connection =
    await db.metaMarketingConnection.findUnique({
      where: {
        shop: audience.shop,
      },
    });

  if (
    !connection ||
    !connection.enabled ||
    !connection.verified
  ) {
    return {
      audienceId: audience.id,
      metaAudienceId:
        audience.metaAudienceId,
      shop: audience.shop,
      status: "SKIPPED",
      message:
        "Meta Marketing API connection is not verified.",
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
      audienceId: audience.id,
      metaAudienceId:
        audience.metaAudienceId,
      shop: audience.shop,
      status: "FAILED",
      message:
        "The Marketing API token could not be decrypted.",
    };
  }

  await db.metaAudience.update({
    where: {
      id: audience.id,
    },
    data: {
      status: "SYNCING",
      operationStatus:
        "AUTOMATIC_SYNC_READING_CUSTOMERS",
      errorMessage: null,
    },
  });

  try {
    const { admin } =
      await unauthenticated.admin(
        audience.shop,
      );

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
          "AUTOMATIC_SYNC_REPLACING_META_AUDIENCE",
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
          `AUTO_REPLACED_${identifiersReceived}_IDENTIFIERS`,
        errorMessage: null,
        lastSyncedAt:
          new Date(),
      },
    });

    return {
      audienceId: audience.id,
      metaAudienceId:
        audience.metaAudienceId,
      shop: audience.shop,
      status: "REFRESHED",
      customerCount:
        identifiers.customerCount,
      identifiersReceived,
    };
  } catch (error) {
    const waitingForMeta =
      error instanceof
        MetaApiRequestError &&
      error.subcode === 1870145;

    if (waitingForMeta) {
      const message =
        "Meta is still processing the previous audience update.";

      await db.metaAudience.update({
        where: {
          id: audience.id,
        },
        data: {
          status: "ACTIVE",
          operationStatus:
            "WAITING_FOR_META",
          errorMessage:
            `${message} | ${error.message}`,
        },
      });

      return {
        audienceId: audience.id,
        metaAudienceId:
          audience.metaAudienceId,
        shop: audience.shop,
        status:
          "WAITING_FOR_META",
        message,
      };
    }

    const errorMessage =
      error instanceof Error
        ? error.message
        : "Automatic audience synchronization failed.";

    await db.metaAudience.update({
      where: {
        id: audience.id,
      },
      data: {
        status: "ERROR",
        operationStatus:
          "AUTOMATIC_SYNC_FAILED",
        errorMessage,
      },
    });

    return {
      audienceId: audience.id,
      metaAudienceId:
        audience.metaAudienceId,
      shop: audience.shop,
      status: "FAILED",
      message: errorMessage,
    };
  }
}

async function runAutomaticSync(
  request: Request,
): Promise<Response> {
  if (!isAuthorized(request)) {
    return jsonResponse(
      {
        ok: false,
        error: "Unauthorized.",
      },
      401,
    );
  }

  const audiences =
    await db.metaAudience.findMany({
      where: {
        metaAudienceId: {
          not: null,
        },
        audienceType:
          "CUSTOMER_FILE",
        status: {
          in: [
            "ACTIVE",
            "ERROR",
          ],
        },
      },
      select: {
        id: true,
        shop: true,
        metaAudienceId: true,
      },
      orderBy: {
        lastSyncedAt: "asc",
      },
    });

  const results: SyncResult[] =
    [];

  for (const audience of audiences) {
    results.push(
      await syncAudience(audience),
    );
  }

  const summary = {
    attempted: results.length,
    refreshed: results.filter(
      (result) =>
        result.status ===
        "REFRESHED",
    ).length,
    waitingForMeta:
      results.filter(
        (result) =>
          result.status ===
          "WAITING_FOR_META",
      ).length,
    failed: results.filter(
      (result) =>
        result.status === "FAILED",
    ).length,
    skipped: results.filter(
      (result) =>
        result.status === "SKIPPED",
    ).length,
  };

  console.log(
    "Automatic Meta audience sync completed",
    summary,
  );

  return jsonResponse({
    ok:
      summary.failed === 0,
    summary,
    results,
  });
}

export const action = async ({
  request,
}: ActionFunctionArgs) =>
  runAutomaticSync(request);

export const loader = async ({
  request,
}: LoaderFunctionArgs) =>
  runAutomaticSync(request);