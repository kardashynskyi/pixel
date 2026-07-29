import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";

import db from "../db.server";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../encryption.server";

type IncomingMetaEvent = {
  shop?: unknown;
  eventName?: unknown;
  eventId?: unknown;
  eventTime?: unknown;
  eventSourceUrl?: unknown;
  userAgent?: unknown;
  customData?: unknown;
  matchingData?: unknown;
};

type MetaResponse = {
  events_received?: number;
  fbtrace_id?: string;
  messages?: string[];
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
};

type IncomingMatchingData = {
  fbp?: unknown;
  fbc?: unknown;
  em?: unknown;
  ph?: unknown;
  fn?: unknown;
  ln?: unknown;
  ct?: unknown;
  st?: unknown;
  zp?: unknown;
  country?: unknown;
  marketingAllowed?: unknown;
};

type NormalizedMatchingData = {
  fbp: string | null;
  fbc: string | null;
  em: string | null;
  ph: string | null;
  fn: string | null;
  ln: string | null;
  ct: string | null;
  st: string | null;
  zp: string | null;
  country: string | null;
  marketingAllowed: boolean;
};

type ResolvedDestination = {
  id: string | null;
  name: string;
  pixelId: string;
  accessTokenCipher: string;
  testEventCode: string | null;
  mode: string;
  isPrimary: boolean;
  browserTracking: boolean;
};

type DestinationResult = {
  destinationId: string | null;
  destinationName: string;
  pixelId: string;
  deliveryId: string;
  status: "DELIVERED" | "REJECTED" | "FAILED";
  eventsReceived: number;
  traceId: string | null;
  error: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
};

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: corsHeaders,
  });
}

function asNonEmptyString(
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned ? cleaned : null;
}

function asEventTime(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return Math.floor(value);
  }

  return Math.floor(Date.now() / 1000);
}

function asCustomData(
  value: unknown,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  return value as Record<string, unknown>;
}

function asMetaBrowserId(
  value: unknown,
): string | null {
  const cleaned = asNonEmptyString(value);

  if (
    !cleaned ||
    !cleaned.startsWith("fb.") ||
    cleaned.length > 2048
  ) {
    return null;
  }

  return cleaned;
}

function asSha256Hash(
  value: unknown,
): string | null {
  const cleaned = asNonEmptyString(value);

  if (
    !cleaned ||
    !/^[a-f0-9]{64}$/.test(cleaned)
  ) {
    return null;
  }

  return cleaned;
}

function asMatchingData(
  value: unknown,
): NormalizedMatchingData {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {
      fbp: null,
      fbc: null,
      em: null,
      ph: null,
      fn: null,
      ln: null,
      ct: null,
      st: null,
      zp: null,
      country: null,
      marketingAllowed: false,
    };
  }

  const incoming = value as IncomingMatchingData;
  const marketingAllowed =
    incoming.marketingAllowed === true;

  return {
    fbp: marketingAllowed
      ? asMetaBrowserId(incoming.fbp)
      : null,
    fbc: marketingAllowed
      ? asMetaBrowserId(incoming.fbc)
      : null,
    em: marketingAllowed
      ? asSha256Hash(incoming.em)
      : null,
    ph: marketingAllowed
      ? asSha256Hash(incoming.ph)
      : null,
    fn: marketingAllowed
      ? asSha256Hash(incoming.fn)
      : null,
    ln: marketingAllowed
      ? asSha256Hash(incoming.ln)
      : null,
    ct: marketingAllowed
      ? asSha256Hash(incoming.ct)
      : null,
    st: marketingAllowed
      ? asSha256Hash(incoming.st)
      : null,
    zp: marketingAllowed
      ? asSha256Hash(incoming.zp)
      : null,
    country: marketingAllowed
      ? asSha256Hash(incoming.country)
      : null,
    marketingAllowed,
  };
}

function getClientIp(
  request: Request,
): string | null {
  const forwardedFor =
    request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    const firstAddress =
      forwardedFor.split(",")[0]?.trim();

    if (firstAddress) {
      return firstAddress;
    }
  }

  const alternativeHeaders = [
    "cf-connecting-ip",
    "true-client-ip",
    "x-real-ip",
  ];

  for (const header of alternativeHeaders) {
    const value =
      request.headers.get(header)?.trim();

    if (value) {
      return value;
    }
  }

  return null;
}

function parseMetaResponse(
  responseText: string,
): MetaResponse {
  if (!responseText.trim()) {
    return {};
  }

  try {
    return JSON.parse(responseText) as MetaResponse;
  } catch {
    return {
      error: {
        message:
          "Meta returned a response that was not valid JSON.",
      },
    };
  }
}

function buildUserData(
  clientIp: string,
  clientUserAgent: string,
  matchingData: NormalizedMatchingData,
): Record<string, string> {
  const userData: Record<string, string> = {
    client_ip_address: clientIp,
    client_user_agent: clientUserAgent,
  };

  if (matchingData.fbp) {
    userData.fbp = matchingData.fbp;
  }

  if (matchingData.fbc) {
    userData.fbc = matchingData.fbc;
  }

  const hashedFields = {
    em: matchingData.em,
    ph: matchingData.ph,
    fn: matchingData.fn,
    ln: matchingData.ln,
    ct: matchingData.ct,
    st: matchingData.st,
    zp: matchingData.zp,
    country: matchingData.country,
  };

  for (const [key, value] of Object.entries(
    hashedFields,
  )) {
    if (value) {
      userData[key] = value;
    }
  }

  return userData;
}

async function getDestinations(
  shop: string,
  settings: {
    metaPixelId: string | null;
    metaAccessTokenCipher: string | null;
    metaTestEventCode: string | null;
    metaMode: string;
    browserTracking: boolean;
  },
): Promise<ResolvedDestination[]> {
  const destinations =
    await db.metaDestination.findMany({
      where: {
        shop,
        enabled: true,
        serverTracking: true,
      },
      orderBy: [
        {
          isPrimary: "desc",
        },
        {
          createdAt: "asc",
        },
      ],
    });

  if (destinations.length) {
    return destinations.map((destination) => ({
      id: destination.id,
      name: destination.name,
      pixelId: destination.pixelId,
      accessTokenCipher:
        destination.accessTokenCipher,
      testEventCode:
        destination.testEventCode,
      mode: destination.mode,
      isPrimary: destination.isPrimary,
      browserTracking:
        destination.browserTracking,
    }));
  }

  const legacyPixelId = asNonEmptyString(
    settings.metaPixelId,
  );

  const legacyToken = asNonEmptyString(
    settings.metaAccessTokenCipher,
  );

  if (!legacyPixelId || !legacyToken) {
    return [];
  }

  return [
    {
      id: null,
      name: "Legacy Primary Meta Pixel",
      pixelId: legacyPixelId,
      accessTokenCipher: legacyToken,
      testEventCode:
        settings.metaTestEventCode,
      mode: settings.metaMode,
      isPrimary: true,
      browserTracking:
        settings.browserTracking,
    },
  ];
}

async function resolveAccessToken(
  shop: string,
  destination: ResolvedDestination,
): Promise<string> {
  if (
    isEncryptedSecret(
      destination.accessTokenCipher,
    )
  ) {
    return decryptSecret(
      destination.accessTokenCipher,
    );
  }

  const encryptedToken = encryptSecret(
    destination.accessTokenCipher,
  );

  if (destination.id) {
    await db.metaDestination.update({
      where: {
        id: destination.id,
      },
      data: {
        accessTokenCipher:
          encryptedToken,
      },
    });
  } else {
    await db.pixelSettings.update({
      where: {
        shop,
      },
      data: {
        metaAccessTokenCipher:
          encryptedToken,
      },
    });
  }

  console.log(
    "Converted legacy Meta access token to encrypted storage",
    {
      shop,
      destinationId: destination.id,
      pixelId: destination.pixelId,
    },
  );

  return destination.accessTokenCipher;
}

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  return jsonResponse({
    ok: true,
    endpoint: "meta-events",
  });
};

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "Method not allowed.",
      },
      405,
    );
  }

  try {
    let incoming: IncomingMetaEvent;

    try {
      incoming =
        (await request.json()) as IncomingMetaEvent;
    } catch {
      return jsonResponse(
        {
          ok: false,
          error:
            "The request body must contain valid JSON.",
        },
        400,
      );
    }

    const shop = asNonEmptyString(incoming.shop);

    const eventName = asNonEmptyString(
      incoming.eventName,
    );

    const eventId = asNonEmptyString(
      incoming.eventId,
    );

    const eventSourceUrl = asNonEmptyString(
      incoming.eventSourceUrl,
    );

    const pixelUserAgent = asNonEmptyString(
      incoming.userAgent,
    );

    if (
      !shop ||
      !eventName ||
      !eventId ||
      !eventSourceUrl
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "shop, eventName, eventId, and eventSourceUrl are required.",
        },
        400,
      );
    }

    const settings =
      await db.pixelSettings.findUnique({
        where: {
          shop,
        },
      });

    if (!settings) {
      return jsonResponse(
        {
          ok: false,
          error:
            "No pixel settings exist for this store.",
        },
        404,
      );
    }

    if (
      !settings.trackingEnabled ||
      !settings.serverTracking
    ) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason:
          "Server-side tracking is disabled.",
      });
    }

    const destinations =
      await getDestinations(shop, settings);

    if (!destinations.length) {
      return jsonResponse(
        {
          ok: false,
          error:
            "No enabled Meta server destinations are configured.",
        },
        400,
      );
    }

    const clientIp = getClientIp(request);

    const clientUserAgent =
      pixelUserAgent ??
      request.headers
        .get("user-agent")
        ?.trim() ??
      null;

    if (!clientIp || !clientUserAgent) {
      return jsonResponse(
        {
          ok: false,
          error:
            "The visitor IP address or browser user agent is missing.",
        },
        400,
      );
    }

    const eventTimeSeconds = asEventTime(
      incoming.eventTime,
    );

    const matchingData = asMatchingData(
      incoming.matchingData,
    );

    const userData = buildUserData(
      clientIp,
      clientUserAgent,
      matchingData,
    );

    const serverEvent = {
      event_name: eventName,
      event_time: eventTimeSeconds,
      event_id: eventId,
      event_source_url: eventSourceUrl,
      action_source: "website",
      user_data: userData,
      custom_data: asCustomData(
        incoming.customData,
      ),
    };

    const results = await Promise.all(
      destinations.map(
        async (
          destination,
        ): Promise<DestinationResult> => {
          const isTestMode =
            destination.mode === "TEST";

          const testEventCode = isTestMode
            ? asNonEmptyString(
                destination.testEventCode,
              )
            : null;

          const delivery =
            await db.metaEventDelivery.create({
              data: {
                shop,
                pixelId:
                  destination.pixelId,
                eventName,
                eventId,
                eventTime: new Date(
                  eventTimeSeconds * 1000,
                ),
                eventSourceUrl,
                browserAttempted:
                  destination.isPrimary &&
                  destination.browserTracking &&
                  settings.browserTracking,
                serverAttempted: true,
                status: "PENDING",
                hasClientIp: true,
                hasClientUserAgent: true,
                hasFbp: Boolean(
                  matchingData.fbp,
                ),
                hasFbc: Boolean(
                  matchingData.fbc,
                ),
                hasEmail: Boolean(
                  matchingData.em,
                ),
                hasPhone: Boolean(
                  matchingData.ph,
                ),
                hasFirstName: Boolean(
                  matchingData.fn,
                ),
                hasLastName: Boolean(
                  matchingData.ln,
                ),
                hasCity: Boolean(
                  matchingData.ct,
                ),
                hasState: Boolean(
                  matchingData.st,
                ),
                hasPostalCode: Boolean(
                  matchingData.zp,
                ),
                hasCountry: Boolean(
                  matchingData.country,
                ),
                marketingAllowed:
                  matchingData.marketingAllowed,
                testMode: isTestMode,
              },
            });

          let accessToken: string;

          try {
            accessToken =
              await resolveAccessToken(
                shop,
                destination,
              );
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : "The Meta access token could not be decrypted.";

            await db.metaEventDelivery.update({
              where: {
                id: delivery.id,
              },
              data: {
                status: "FAILED",
                errorMessage,
              },
            });

            return {
              destinationId:
                destination.id,
              destinationName:
                destination.name,
              pixelId:
                destination.pixelId,
              deliveryId: delivery.id,
              status: "FAILED",
              eventsReceived: 0,
              traceId: null,
              error: errorMessage,
            };
          }

          const metaPayload: {
            data: typeof serverEvent[];
            test_event_code?: string;
          } = {
            data: [serverEvent],
          };

          if (testEventCode) {
            metaPayload.test_event_code =
              testEventCode;
          }

          const metaUrl = new URL(
            `https://graph.facebook.com/v22.0/${encodeURIComponent(
              destination.pixelId,
            )}/events`,
          );

          metaUrl.searchParams.set(
            "access_token",
            accessToken,
          );

          let metaRequest: Response;

          try {
            metaRequest = await fetch(
              metaUrl,
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/json",
                },
                body: JSON.stringify(
                  metaPayload,
                ),
              },
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : "Meta request failed before a response was received.";

            await db.metaEventDelivery.update({
              where: {
                id: delivery.id,
              },
              data: {
                status: "FAILED",
                errorMessage,
              },
            });

            console.error(
              "Meta Conversions API request failed",
              {
                shop,
                eventName,
                eventId,
                destinationId:
                  destination.id,
                destinationName:
                  destination.name,
                pixelId:
                  destination.pixelId,
                deliveryId:
                  delivery.id,
                error: errorMessage,
              },
            );

            return {
              destinationId:
                destination.id,
              destinationName:
                destination.name,
              pixelId:
                destination.pixelId,
              deliveryId: delivery.id,
              status: "FAILED",
              eventsReceived: 0,
              traceId: null,
              error: errorMessage,
            };
          }

          const metaResponseText =
            await metaRequest.text();

          const metaResponse =
            parseMetaResponse(
              metaResponseText,
            );

          if (
            !metaRequest.ok ||
            metaResponse.error
          ) {
            const errorMessage =
              metaResponse.error?.message ??
              "Meta rejected the server event.";

            await db.metaEventDelivery.update({
              where: {
                id: delivery.id,
              },
              data: {
                status: "REJECTED",
                httpStatus:
                  metaRequest.status,
                eventsReceived:
                  metaResponse.events_received ??
                  null,
                fbTraceId:
                  metaResponse.error
                    ?.fbtrace_id ??
                  metaResponse.fbtrace_id ??
                  null,
                errorMessage,
                errorType:
                  metaResponse.error?.type ??
                  null,
                errorCode:
                  metaResponse.error?.code ??
                  null,
                errorSubcode:
                  metaResponse.error
                    ?.error_subcode ??
                  null,
                errorIsTransient:
                  metaResponse.error
                    ?.is_transient ??
                  null,
                errorUserTitle:
                  metaResponse.error
                    ?.error_user_title ??
                  null,
                errorUserMessage:
                  metaResponse.error
                    ?.error_user_msg ??
                  null,
              },
            });

            console.error(
              "Meta Conversions API rejected event",
              {
                shop,
                eventName,
                eventId,
                destinationId:
                  destination.id,
                destinationName:
                  destination.name,
                pixelId:
                  destination.pixelId,
                deliveryId:
                  delivery.id,
                status:
                  metaRequest.status,
                error:
                  metaResponse.error,
              },
            );

            return {
              destinationId:
                destination.id,
              destinationName:
                destination.name,
              pixelId:
                destination.pixelId,
              deliveryId: delivery.id,
              status: "REJECTED",
              eventsReceived:
                metaResponse.events_received ??
                0,
              traceId:
                metaResponse.error
                  ?.fbtrace_id ??
                metaResponse.fbtrace_id ??
                null,
              error: errorMessage,
            };
          }

          const deliveredAt = new Date();

          await db.metaEventDelivery.update({
            where: {
              id: delivery.id,
            },
            data: {
              status: "DELIVERED",
              httpStatus:
                metaRequest.status,
              eventsReceived:
                metaResponse.events_received ??
                0,
              fbTraceId:
                metaResponse.fbtrace_id ??
                null,
              deliveredAt,
            },
          });

          console.log(
            "Meta Conversions API event delivered",
            {
              shop,
              eventName,
              eventId,
              destinationId:
                destination.id,
              destinationName:
                destination.name,
              pixelId:
                destination.pixelId,
              deliveryId: delivery.id,
              eventsReceived:
                metaResponse.events_received,
              traceId:
                metaResponse.fbtrace_id,
              hasClientIp: true,
              hasClientUserAgent: true,
              hasFbp: Boolean(
                matchingData.fbp,
              ),
              hasFbc: Boolean(
                matchingData.fbc,
              ),
              hasEmail: Boolean(
                matchingData.em,
              ),
              hasPhone: Boolean(
                matchingData.ph,
              ),
              hasFirstName: Boolean(
                matchingData.fn,
              ),
              hasLastName: Boolean(
                matchingData.ln,
              ),
              hasCity: Boolean(
                matchingData.ct,
              ),
              hasState: Boolean(
                matchingData.st,
              ),
              hasPostalCode: Boolean(
                matchingData.zp,
              ),
              hasCountry: Boolean(
                matchingData.country,
              ),
              marketingAllowed:
                matchingData.marketingAllowed,
            },
          );

          return {
            destinationId:
              destination.id,
            destinationName:
              destination.name,
            pixelId:
              destination.pixelId,
            deliveryId: delivery.id,
            status: "DELIVERED",
            eventsReceived:
              metaResponse.events_received ??
              0,
            traceId:
              metaResponse.fbtrace_id ??
              null,
            error: null,
          };
        },
      ),
    );

    const deliveredCount = results.filter(
      (result) =>
        result.status === "DELIVERED",
    ).length;

    const rejectedCount = results.filter(
      (result) =>
        result.status === "REJECTED",
    ).length;

    const failedCount = results.filter(
      (result) =>
        result.status === "FAILED",
    ).length;

    return jsonResponse(
      {
        ok: deliveredCount > 0,
        eventName,
        eventId,
        destinationCount:
          destinations.length,
        deliveredCount,
        rejectedCount,
        failedCount,
        partialFailure:
          deliveredCount > 0 &&
          deliveredCount <
            destinations.length,
        results,
      },
      deliveredCount > 0 ? 200 : 502,
    );
  } catch (error) {
    console.error(
      "Meta event endpoint failed",
      error,
    );

    return jsonResponse(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unexpected server error.",
      },
      500,
    );
  }
};