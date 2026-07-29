import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { authenticate } from "../shopify.server";

type IncomingMetaEvent = {
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
    fbtrace_id?: string;
  };
};

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

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned ? cleaned : null;
}

function asEventTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  return Math.floor(Date.now() / 1000);
}

function asCustomData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

/*
 * Allows a browser or monitoring tool to confirm that the route exists.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  return jsonResponse({
    ok: true,
    endpoint: "meta-events",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    /*
     * Shopify verifies the app-proxy signature before this request is accepted.
     */
    await authenticate.public.appProxy(request);

    if (request.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "Method not allowed.",
        },
        405,
      );
    }

    const requestUrl = new URL(request.url);
    const shop = asNonEmptyString(requestUrl.searchParams.get("shop"));

    if (!shop) {
      return jsonResponse(
        {
          ok: false,
          error: "Shopify did not provide a shop domain.",
        },
        400,
      );
    }

    const settings = await db.pixelSettings.findUnique({
      where: {
        shop,
      },
    });

    if (!settings) {
      return jsonResponse(
        {
          ok: false,
          error: "No pixel settings exist for this store.",
        },
        404,
      );
    }

    if (!settings.trackingEnabled || !settings.serverTracking) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "Server-side tracking is disabled.",
      });
    }

    const pixelId = asNonEmptyString(settings.metaPixelId);
    const accessToken = asNonEmptyString(
      settings.metaAccessTokenCipher,
    );

    if (!pixelId || !accessToken) {
      return jsonResponse(
        {
          ok: false,
          error: "Meta Pixel ID or access token is missing.",
        },
        400,
      );
    }

    let incoming: IncomingMetaEvent;

    try {
      incoming = (await request.json()) as IncomingMetaEvent;
    } catch {
      return jsonResponse(
        {
          ok: false,
          error: "The request body must contain valid JSON.",
        },
        400,
      );
    }

    const eventName = asNonEmptyString(incoming.eventName);
    const eventId = asNonEmptyString(incoming.eventId);
    const eventSourceUrl = asNonEmptyString(
      incoming.eventSourceUrl,
    );
    const userAgent = asNonEmptyString(incoming.userAgent);

    if (!eventName || !eventId || !eventSourceUrl) {
      return jsonResponse(
        {
          ok: false,
          error:
            "eventName, eventId, and eventSourceUrl are required.",
        },
        400,
      );
    }

    const serverEvent = {
      event_name: eventName,
      event_time: asEventTime(incoming.eventTime),
      event_id: eventId,
      event_source_url: eventSourceUrl,
      action_source: "website",
      user_data: {
        client_user_agent:
          userAgent ?? request.headers.get("user-agent") ?? "",
      },
      custom_data: asCustomData(incoming.customData),
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
      metaPayload.test_event_code = testEventCode;
    }

    const metaUrl = new URL(
      `https://graph.facebook.com/v22.0/${encodeURIComponent(
        pixelId,
      )}/events`,
    );

    metaUrl.searchParams.set("access_token", accessToken);

    const metaRequest = await fetch(metaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metaPayload),
    });

    const metaResponse = (await metaRequest.json()) as MetaResponse;

    if (!metaRequest.ok || metaResponse.error) {
      console.error("Meta Conversions API rejected event", {
        shop,
        eventName,
        eventId,
        status: metaRequest.status,
        error: metaResponse.error,
      });

      return jsonResponse(
        {
          ok: false,
          error:
            metaResponse.error?.message ??
            "Meta rejected the server event.",
          metaStatus: metaRequest.status,
        },
        502,
      );
    }

    console.log("Meta Conversions API event delivered", {
      shop,
      eventName,
      eventId,
      eventsReceived: metaResponse.events_received,
      traceId: metaResponse.fbtrace_id,
    });

    return jsonResponse({
      ok: true,
      eventName,
      eventId,
      eventsReceived: metaResponse.events_received ?? 0,
      traceId: metaResponse.fbtrace_id ?? null,
    });
  } catch (error) {
    console.error("Meta event endpoint failed", error);

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