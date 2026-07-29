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

  const destinations =
    await db.metaDestination.findMany({
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
    });

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
        eventName: true,
        eventId: true,
        status: true,
        httpStatus: true,
        eventsReceived: true,
        testMode: true,
        errorMessage: true,
        createdAt: true,
        deliveredAt: true,
      },
    }),
  ]);

  const acceptanceRate =
    attemptedCount > 0
      ? Math.round(
          (deliveredCount / attemptedCount) *
            1000,
        ) / 10
      : 0;

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
          createdAt:
            event.createdAt.toISOString(),
          deliveredAt:
            event.deliveredAt?.toISOString() ??
            null,
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
                          Event
                        </th>
                        <th style={{ textAlign: "left", padding: "8px" }}>
                          Status
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
                  ? "Token already saved â€” leave blank to keep it"
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