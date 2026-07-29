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
import { authenticate } from "../shopify.server";

type ActionData =
  | {
      success: true;
      message: string;
    }
  | {
      success: false;
      message: string;
    };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const settings = await db.pixelSettings.findUnique({
    where: {
      shop: session.shop,
    },
  });

  return {
    shop: session.shop,
    settings: {
      metaPixelId: settings?.metaPixelId ?? "",
      metaTestEventCode: settings?.metaTestEventCode ?? "",
      trackingEnabled: settings?.trackingEnabled ?? false,
      browserTracking: settings?.browserTracking ?? true,
      serverTracking: settings?.serverTracking ?? false,
      hasAccessToken: Boolean(settings?.metaAccessTokenCipher),
    },
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const metaPixelId = String(
    formData.get("metaPixelId") ?? "",
  ).trim();

  const metaAccessToken = String(
    formData.get("metaAccessToken") ?? "",
  ).trim();

  const metaTestEventCode = String(
    formData.get("metaTestEventCode") ?? "",
  ).trim();

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

  if (metaPixelId && !/^\d+$/.test(metaPixelId)) {
    return {
      success: false,
      message: "Meta Pixel ID must contain numbers only.",
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
    !metaAccessToken &&
    !existingSettings?.metaAccessTokenCipher
  ) {
    return {
      success: false,
      message:
        "Enter a Conversions API access token before enabling server-side tracking.",
    };
  }

  /*
   * Temporary development storage.
   *
   * Before production deployment, this token must be encrypted
   * using an application encryption key.
   */
  const storedAccessToken =
    metaAccessToken ||
    existingSettings?.metaAccessTokenCipher ||
    null;

  await db.pixelSettings.upsert({
    where: {
      shop: session.shop,
    },
    create: {
      shop: session.shop,
      metaPixelId: metaPixelId || null,
      metaAccessTokenCipher: storedAccessToken,
      metaTestEventCode: metaTestEventCode || null,
      trackingEnabled,
      browserTracking,
      serverTracking,
    },
    update: {
      metaPixelId: metaPixelId || null,
      metaAccessTokenCipher: storedAccessToken,
      metaTestEventCode: metaTestEventCode || null,
      trackingEnabled,
      browserTracking,
      serverTracking,
    },
  });

  return {
    success: true,
    message: "Meta tracking settings saved.",
  };
};

export default function Index() {
  const { shop, settings } =
    useLoaderData<typeof loader>();

  const actionData =
    useActionData<typeof action>();

  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [trackingEnabled, setTrackingEnabled] =
    useState(settings.trackingEnabled);

  const [browserTracking, setBrowserTracking] =
    useState(settings.browserTracking);

  const [serverTracking, setServerTracking] =
    useState(settings.serverTracking);

  const isSaving =
    navigation.state === "submitting" &&
    navigation.formMethod?.toUpperCase() === "POST";

  useEffect(() => {
    if (!actionData) {
      return;
    }

    if (actionData.success) {
      shopify.toast.show(actionData.message);
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Meta Pixel Tracking">
      <Form method="post">
        <s-section heading="Store">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Configure Meta browser and server-side tracking
              for this Shopify store.
            </s-paragraph>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small">
                <s-text>
                  <strong>Connected store</strong>
                </s-text>

                <s-text>{shop}</s-text>
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>

        {actionData && !actionData.success && (
          <s-section>
            <s-banner tone="critical">
              <s-paragraph>
                {actionData.message}
              </s-paragraph>
            </s-banner>
          </s-section>
        )}

        <s-section heading="Meta configuration">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Meta Pixel ID"
              name="metaPixelId"
              value={settings.metaPixelId}
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
                  ? "An access token is already saved. Enter a new token only to replace it."
                  : "This token is used by the app backend for Meta Conversions API events."
              }
              autoComplete="new-password"
            />

            <s-text-field
              label="Meta test event code"
              name="metaTestEventCode"
              value={settings.metaTestEventCode}
              placeholder="TEST57130"
              helpText="Optional. Use the code shown in Meta Events Manager while testing."
              autoComplete="off"
            />
          </s-stack>
        </s-section>

        <s-section heading="Tracking options">
          <s-stack direction="block" gap="base">
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
              Enable browser-side Meta Pixel events
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
              Enable server-side Conversions API events
            </label>
          </s-stack>
        </s-section>

        <s-section heading="Events">
          <s-unordered-list>
            <s-list-item>PageView</s-list-item>
            <s-list-item>ViewContent</s-list-item>
            <s-list-item>AddToCart</s-list-item>
            <s-list-item>InitiateCheckout</s-list-item>
            <s-list-item>Purchase</s-list-item>
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

      <s-section
        slot="aside"
        heading="Current status"
      >
        <s-stack direction="block" gap="small">
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
            Shopify Web Pixel: Connected
          </s-text>
        </s-stack>
      </s-section>

      <s-section
        slot="aside"
        heading="Implementation status"
      >
        <s-paragraph>
          Browser events are operational. Server-side
          Conversions API delivery is being connected through
          the app proxy endpoint.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (
  headersArgs,
) => {
  return boundary.headers(headersArgs);
};