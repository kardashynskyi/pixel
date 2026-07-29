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
  encryptSecret,
  isEncryptedSecret,
} from "../encryption.server";
import { authenticate } from "../shopify.server";

type AdminClient = Awaited<
  ReturnType<typeof authenticate.admin>
>["admin"];

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

type ActionData =
  | {
      success: true;
      message: string;
      webPixelId: string;
    }
  | {
      success: false;
      message: string;
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

  return {
    shop: session.shop,
    settings: {
      metaPixelId:
        settings?.metaPixelId ?? "",
      metaTestEventCode:
        settings?.metaTestEventCode ?? "",
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
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session } =
    await authenticate.admin(request);

  const formData = await request.formData();

  const metaPixelId = String(
    formData.get("metaPixelId") ?? "",
  ).trim();

  const submittedAccessToken = String(
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

  try {
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
          metaTestEventCode || null,
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
          metaTestEventCode || null,
        trackingEnabled,
        browserTracking,
        serverTracking,
      },
    });

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
        ? "Settings saved and Shopify Web Pixel updated."
        : "Settings saved and Shopify Web Pixel created.",
      webPixelId: synchronizedWebPixel.id,
    };
  } catch (error) {
    console.error(
      "Failed to save and synchronize Meta settings",
      error,
    );

    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Meta settings could not be saved.",
    };
  }
};

export default function Index() {
  const {
    shop,
    settings,
    webPixel,
  } = useLoaderData<typeof loader>();

  const actionData =
    useActionData<typeof action>();

  const navigation = useNavigation();
  const shopify = useAppBridge();

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
      <Form method="post">
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

            <s-text-field
              label="Meta test event code"
              name="metaTestEventCode"
              value={
                settings.metaTestEventCode
              }
              placeholder="TEST57130"
              helpText="Leave this blank for live production tracking."
              autoComplete="off"
            />
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

      <s-section
        slot="aside"
        heading="Current status"
      >
        <s-stack
          direction="block"
          gap="small"
        >
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