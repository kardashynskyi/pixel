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

    const pixelId = asNonEmptyString(
      settings.metaPixelId,
    );

    const storedAccessToken = asNonEmptyString(
      settings.metaAccessTokenCipher,
    );

    if (!pixelId || !storedAccessToken) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Meta Pixel ID or access token is missing.",
        },
        400,
      );
    }

    let accessToken: string;

    if (isEncryptedSecret(storedAccessToken)) {
      accessToken =
        decryptSecret(storedAccessToken);
    } else {
      accessToken = storedAccessToken;

      const encryptedToken =
        encryptSecret(storedAccessToken);

      await db.pixelSettings.update({
        where: {
          shop,
        },
        data: {
          metaAccessTokenCipher:
            encryptedToken,
        },
      });

      console.log(
        "Converted legacy Meta access token to encrypted storage",
        {
          shop,
        },
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

    const serverEvent = {
      event_name: eventName,
      event_time: asEventTime(
        incoming.eventTime,
      ),
      event_id: eventId,
      event_source_url: eventSourceUrl,
      action_source: "website",
      user_data: {
        client_ip_address: clientIp,
        client_user_agent: clientUserAgent,
      },
      custom_data: asCustomData(
        incoming.customData,
      ),
    };

    const metaPayload: {
      data: typeof serverEvent[];
      test_event_code?: string;
    } = {
      data: [serverEvent],
    };

    const testEventCode = asNonEmptyString(
      settings.metaTestEventCode,
    );

    if (testEventCode) {
      metaPayload.test_event_code =
        testEventCode;
    }

    const metaUrl = new URL(
      `https://graph.facebook.com/v22.0/${encodeURIComponent(
        pixelId,
      )}/events`,
    );

    metaUrl.searchParams.set(
      "access_token",
      accessToken,
    );

    const metaRequest = await fetch(metaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metaPayload),
    });

    const metaResponse =
      (await metaRequest.json()) as MetaResponse;

    if (!metaRequest.ok || metaResponse.error) {
      console.error(
        "Meta Conversions API rejected event",
        {
          shop,
          eventName,
          eventId,
          status: metaRequest.status,
          error: metaResponse.error,
        },
      );

      return jsonResponse(
        {
          ok: false,
          error:
            metaResponse.error?.message ??
            "Meta rejected the server event.",
          userTitle:
            metaResponse.error
              ?.error_user_title ?? null,
          userMessage:
            metaResponse.error
              ?.error_user_msg ?? null,
          metaStatus: metaRequest.status,
        },
        502,
      );
    }

    console.log(
      "Meta Conversions API event delivered",
      {
        shop,
        eventName,
        eventId,
        eventsReceived:
          metaResponse.events_received,
        traceId: metaResponse.fbtrace_id,
        hasClientIp: true,
        hasClientUserAgent: true,
      },
    );

    return jsonResponse({
      ok: true,
      eventName,
      eventId,
      eventsReceived:
        metaResponse.events_received ?? 0,
      traceId:
        metaResponse.fbtrace_id ?? null,
    });
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