import { register } from "@shopify/web-pixels-extension";

type PixelSettings = {
  pixel_id?: string;
  tracking_enabled?: string;
  browser_tracking?: string;
};

type MoneyValue = {
  amount?: string | number | null;
  currencyCode?: string | null;
};

type MetaEventParameters = {
  value?: string | number;
  currency?: string;
  content_ids?: string[];
  content_name?: string;
  content_type?: string;
  contents?: Array<{
    id: string;
    quantity: number;
    item_price?: string | number;
  }>;
  num_items?: number;
  search_string?: string;
};

type ServerEventPayload = {
  eventName: string;
  eventId: string;
  eventTime: number;
  eventSourceUrl: string;
  userAgent: string;
  customData: MetaEventParameters;
};

function isEnabled(value: unknown): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

function cleanId(value: unknown): string {
  return String(value ?? "")
    .replace("gid://shopify/ProductVariant/", "")
    .replace("gid://shopify/Product/", "")
    .trim();
}

function getMoneyValue(
  money: MoneyValue | null | undefined,
): {
  value?: string | number;
  currency?: string;
} {
  if (!money) {
    return {};
  }

  return {
    value: money.amount ?? undefined,
    currency: money.currencyCode ?? undefined,
  };
}

function getEventTime(timestamp: unknown): number {
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);

    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return Math.floor(timestamp / 1000);
  }

  return Math.floor(Date.now() / 1000);
}

function getUserAgent(context: unknown): string {
  if (!context || typeof context !== "object") {
    return "";
  }

  const contextRecord = context as Record<string, unknown>;
  const navigatorValue = contextRecord.navigator;

  if (!navigatorValue || typeof navigatorValue !== "object") {
    return "";
  }

  const navigatorRecord =
    navigatorValue as Record<string, unknown>;

  return typeof navigatorRecord.userAgent === "string"
    ? navigatorRecord.userAgent
    : "";
}

function appendCustomData(
  params: URLSearchParams,
  customData: MetaEventParameters,
): void {
  if (customData.value !== undefined) {
    params.set("cd[value]", String(customData.value));
  }

  if (customData.currency) {
    params.set("cd[currency]", customData.currency);
  }

  if (customData.content_name) {
    params.set(
      "cd[content_name]",
      customData.content_name,
    );
  }

  if (customData.content_type) {
    params.set(
      "cd[content_type]",
      customData.content_type,
    );
  }

  if (customData.content_ids?.length) {
    params.set(
      "cd[content_ids]",
      JSON.stringify(customData.content_ids),
    );
  }

  if (customData.contents?.length) {
    params.set(
      "cd[contents]",
      JSON.stringify(customData.contents),
    );
  }

  if (customData.num_items !== undefined) {
    params.set(
      "cd[num_items]",
      String(customData.num_items),
    );
  }

  if (customData.search_string) {
    params.set(
      "cd[search_string]",
      customData.search_string,
    );
  }
}

register(({ analytics, settings }) => {
  const pixelSettings = settings as PixelSettings;

  const pixelId = String(
    pixelSettings.pixel_id ?? "",
  ).trim();

  const trackingEnabled = isEnabled(
    pixelSettings.tracking_enabled,
  );

  const browserTrackingEnabled = isEnabled(
    pixelSettings.browser_tracking,
  );

  if (!pixelId || !trackingEnabled) {
    return;
  }

  async function sendBrowserEvent(
    eventName: string,
    eventId: string,
    pageUrl: string,
    customData: MetaEventParameters,
  ): Promise<void> {
    if (!browserTrackingEnabled) {
      return;
    }

    const params = new URLSearchParams();

    params.set("id", pixelId);
    params.set("ev", eventName);
    params.set("dl", pageUrl);
    params.set("ts", String(Date.now()));
    params.set("eid", eventId);
    params.set("noscript", "1");

    appendCustomData(params, customData);

    try {
      await fetch(
        `https://www.facebook.com/tr/?${params.toString()}`,
        {
          method: "GET",
          mode: "no-cors",
          keepalive: true,
        },
      );
    } catch (error) {
      console.error(
        `[Meta Pixel] Browser ${eventName} failed`,
        error,
      );
    }
  }

  async function sendServerEvent(
    payload: ServerEventPayload,
  ): Promise<void> {
    try {
      const proxyUrl = new URL(
        "/apps/pixel-events",
        payload.eventSourceUrl,
      );

      await fetch(proxyUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch (error) {
      console.error(
        `[Meta Pixel] Server ${payload.eventName} failed`,
        error,
      );
    }
  }

  function sendEvent(
    eventName: string,
    eventId: string,
    timestamp: unknown,
    pageUrl: string,
    context: unknown,
    customData: MetaEventParameters = {},
  ): void {
    void sendBrowserEvent(
      eventName,
      eventId,
      pageUrl,
      customData,
    );

    void sendServerEvent({
      eventName,
      eventId,
      eventTime: getEventTime(timestamp),
      eventSourceUrl: pageUrl,
      userAgent: getUserAgent(context),
      customData,
    });
  }

  analytics.subscribe("page_viewed", (event) => {
    sendEvent(
      "PageView",
      event.id,
      event.timestamp,
      event.context.document.location.href,
      event.context,
    );
  });

  analytics.subscribe("product_viewed", (event) => {
    const variant = event.data.productVariant;

    if (!variant) {
      return;
    }

    const variantId = cleanId(variant.id);
    const money = getMoneyValue(variant.price);

    sendEvent(
      "ViewContent",
      event.id,
      event.timestamp,
      event.context.document.location.href,
      event.context,
      {
        ...money,
        content_ids: variantId ? [variantId] : [],
        content_name:
          variant.product?.title ??
          variant.title ??
          undefined,
        content_type: "product",
        contents: variantId
          ? [
              {
                id: variantId,
                quantity: 1,
                item_price: money.value,
              },
            ]
          : [],
      },
    );
  });

  analytics.subscribe(
    "product_added_to_cart",
    (event) => {
      const cartLine = event.data.cartLine;
      const merchandise = cartLine?.merchandise;

      if (!cartLine || !merchandise) {
        return;
      }

      const variantId = cleanId(merchandise.id);
      const quantity = cartLine.quantity ?? 1;
      const money = getMoneyValue(
        cartLine.cost?.totalAmount,
      );

      sendEvent(
        "AddToCart",
        event.id,
        event.timestamp,
        event.context.document.location.href,
        event.context,
        {
          ...money,
          content_ids: variantId
            ? [variantId]
            : [],
          content_name:
            merchandise.product?.title ??
            merchandise.title ??
            undefined,
          content_type: "product",
          num_items: quantity,
          contents: variantId
            ? [
                {
                  id: variantId,
                  quantity,
                  item_price:
                    merchandise.price?.amount ??
                    undefined,
                },
              ]
            : [],
        },
      );
    },
  );

  analytics.subscribe("search_submitted", (event) => {
    sendEvent(
      "Search",
      event.id,
      event.timestamp,
      event.context.document.location.href,
      event.context,
      {
        search_string:
          event.data.searchResult?.query ?? "",
      },
    );
  });

  analytics.subscribe("checkout_started", (event) => {
    const checkout = event.data.checkout;
    const lines = checkout?.lineItems ?? [];

    const contents = lines
      .map((line) => {
        const id = cleanId(line.variant?.id);

        if (!id) {
          return null;
        }

        return {
          id,
          quantity: line.quantity ?? 1,
          item_price:
            line.variant?.price?.amount ??
            undefined,
        };
      })
      .filter(
        (
          item,
        ): item is {
          id: string;
          quantity: number;
          item_price:
            | string
            | number
            | undefined;
        } => item !== null,
      );

    const money = getMoneyValue(
      checkout?.totalPrice,
    );

    sendEvent(
      "InitiateCheckout",
      event.id,
      event.timestamp,
      event.context.document.location.href,
      event.context,
      {
        ...money,
        content_ids: contents.map(
          (item) => item.id,
        ),
        content_type: "product",
        contents,
        num_items: contents.reduce(
          (total, item) =>
            total + item.quantity,
          0,
        ),
      },
    );
  });

  analytics.subscribe(
    "checkout_completed",
    (event) => {
      const checkout = event.data.checkout;
      const lines = checkout?.lineItems ?? [];

      const contents = lines
        .map((line) => {
          const id = cleanId(line.variant?.id);

          if (!id) {
            return null;
          }

          return {
            id,
            quantity: line.quantity ?? 1,
            item_price:
              line.variant?.price?.amount ??
              undefined,
          };
        })
        .filter(
          (
            item,
          ): item is {
            id: string;
            quantity: number;
            item_price:
              | string
              | number
              | undefined;
          } => item !== null,
        );

      const money = getMoneyValue(
        checkout?.totalPrice,
      );

      sendEvent(
        "Purchase",
        event.id,
        event.timestamp,
        event.context.document.location.href,
        event.context,
        {
          ...money,
          content_ids: contents.map(
            (item) => item.id,
          ),
          content_type: "product",
          contents,
          num_items: contents.reduce(
            (total, item) =>
              total + item.quantity,
            0,
          ),
        },
      );
    },
  );
});