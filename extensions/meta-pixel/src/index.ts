import { register } from "@shopify/web-pixels-extension";

type PixelSettings = {
  pixel_id?: string;
  shop_domain?: string;
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

type MatchingData = {
  fbp?: string;
  fbc?: string;
  em?: string;
  ph?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  st?: string;
  zp?: string;
  country?: string;
  marketingAllowed: boolean;
};

type CustomerMatchingInput = {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

type CustomerPrivacyStatus = {
  marketingAllowed?: boolean;
};

type ServerEventPayload = {
  shop: string;
  eventName: string;
  eventId: string;
  eventTime: number;
  eventSourceUrl: string;
  userAgent: string;
  customData: MetaEventParameters;
  matchingData: MatchingData;
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
    const parsedTimestamp = Date.parse(timestamp);

    if (Number.isFinite(parsedTimestamp)) {
      return Math.floor(parsedTimestamp / 1000);
    }
  }

  if (
    typeof timestamp === "number" &&
    Number.isFinite(timestamp)
  ) {
    return timestamp > 10_000_000_000
      ? Math.floor(timestamp / 1000)
      : Math.floor(timestamp);
  }

  return Math.floor(Date.now() / 1000);
}

function getUserAgent(context: unknown): string {
  if (!context || typeof context !== "object") {
    return "";
  }

  const contextRecord = context as Record<string, unknown>;
  const navigatorValue = contextRecord.navigator;

  if (
    !navigatorValue ||
    typeof navigatorValue !== "object"
  ) {
    return "";
  }

  const navigatorRecord =
    navigatorValue as Record<string, unknown>;

  return typeof navigatorRecord.userAgent === "string"
    ? navigatorRecord.userAgent
    : "";
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function cleanCookieValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const cleaned = value.trim();

  return cleaned || undefined;
}

function getFbclid(pageUrl: string): string | null {
  try {
    const value = new URL(pageUrl).searchParams.get("fbclid");
    return value?.trim() || null;
  } catch {
    return null;
  }
}

function createFbcFromFbclid(
  pageUrl: string,
  eventTime: number,
): string | undefined {
  const fbclid = getFbclid(pageUrl);

  if (!fbclid) {
    return undefined;
  }

  return `fb.1.${eventTime * 1000}.${fbclid}`;
}

function asInputString(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned || null;
}

function normalizeEmail(
  value: string | null | undefined,
): string | null {
  return asInputString(value)?.toLowerCase() ?? null;
}

function normalizePhone(
  value: string | null | undefined,
): string | null {
  const cleaned = asInputString(value);

  if (!cleaned) {
    return null;
  }

  const digits = cleaned.replace(/\D/g, "");

  return digits || null;
}

function normalizeText(
  value: string | null | undefined,
): string | null {
  const cleaned = asInputString(value);

  if (!cleaned) {
    return null;
  }

  const normalized = cleaned
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

  return normalized || null;
}

function normalizePostalCode(
  value: string | null | undefined,
  country: string | null | undefined,
): string | null {
  const cleaned = asInputString(value);

  if (!cleaned) {
    return null;
  }

  const normalized = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  const normalizedCountry =
    normalizeText(country);

  if (
    normalizedCountry === "us" ||
    normalizedCountry === "usa" ||
    normalizedCountry === "unitedstates"
  ) {
    const firstFiveDigits =
      normalized.replace(/\D/g, "").slice(0, 5);

    return firstFiveDigits || null;
  }

  return normalized || null;
}

async function sha256Hex(
  value: string | null,
): Promise<string | undefined> {
  if (!value) {
    return undefined;
  }

  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes,
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) =>
      byte.toString(16).padStart(2, "0"),
    )
    .join("");
}

async function buildHashedCustomerData(
  input: CustomerMatchingInput | undefined,
): Promise<
  Pick<
    MatchingData,
    | "em"
    | "ph"
    | "fn"
    | "ln"
    | "ct"
    | "st"
    | "zp"
    | "country"
  >
> {
  if (!input) {
    return {};
  }

  const [
    em,
    ph,
    fn,
    ln,
    ct,
    st,
    zp,
    country,
  ] = await Promise.all([
    sha256Hex(normalizeEmail(input.email)),
    sha256Hex(normalizePhone(input.phone)),
    sha256Hex(normalizeText(input.firstName)),
    sha256Hex(normalizeText(input.lastName)),
    sha256Hex(normalizeText(input.city)),
    sha256Hex(normalizeText(input.state)),
    sha256Hex(
      normalizePostalCode(
        input.postalCode,
        input.country,
      ),
    ),
    sha256Hex(normalizeText(input.country)),
  ]);

  return {
    em,
    ph,
    fn,
    ln,
    ct,
    st,
    zp,
    country,
  };
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

register(({
  analytics,
  browser,
  customerPrivacy,
  init,
  settings,
}) => {
  const pixelSettings = settings as PixelSettings;

  const pixelId = String(
    pixelSettings.pixel_id ?? "",
  ).trim();

  const configuredShopDomain = String(
    pixelSettings.shop_domain ?? "",
  )
    .trim()
    .toLowerCase();

  const trackingEnabled = isEnabled(
    pixelSettings.tracking_enabled,
  );

  const browserTrackingEnabled = isEnabled(
    pixelSettings.browser_tracking,
  );

  let customerPrivacyStatus =
    init.customerPrivacy as CustomerPrivacyStatus;

  void customerPrivacy.subscribe(
    "visitorConsentCollected",
    (event) => {
      customerPrivacyStatus =
        event.customerPrivacy as CustomerPrivacyStatus;
    },
  );

  if (
    !pixelId ||
    !configuredShopDomain ||
    !trackingEnabled
  ) {
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
      const response = await fetch(
        "https://pixel-dpu5.onrender.com/meta-events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          keepalive: true,
        },
      );

      if (!response.ok) {
        const responseText = await response.text();

        console.error(
          `[Meta Pixel] Server ${payload.eventName} rejected`,
          {
            status: response.status,
            response: responseText,
          },
        );
      }
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
    customerMatchingInput?: CustomerMatchingInput,
  ): void {
    const eventTime = getEventTime(timestamp);

    void sendBrowserEvent(
      eventName,
      eventId,
      pageUrl,
      customData,
    );

    void (async () => {
      const marketingAllowed =
        customerPrivacyStatus.marketingAllowed === true;

      let fbp: string | undefined;
      let fbc: string | undefined;
      let hashedCustomerData: Awaited<
        ReturnType<typeof buildHashedCustomerData>
      > = {};

      if (marketingAllowed) {
        try {
          const [storedFbp, storedFbc] =
            await Promise.all([
              browser.cookie.get("_fbp"),
              browser.cookie.get("_fbc"),
            ]);

          fbp = cleanCookieValue(storedFbp);
          fbc =
            cleanCookieValue(storedFbc) ??
            createFbcFromFbclid(
              pageUrl,
              eventTime,
            );

          hashedCustomerData =
            await buildHashedCustomerData(
              customerMatchingInput,
            );
        } catch (error) {
          console.error(
            `[Meta Pixel] Matching data lookup failed for ${eventName}`,
            error,
          );
        }
      }

      await sendServerEvent({
        shop: configuredShopDomain,
        eventName,
        eventId,
        eventTime,
        eventSourceUrl: pageUrl,
        userAgent: getUserAgent(context),
        customData,
        matchingData: {
          fbp,
          fbc,
          ...hashedCustomerData,
          marketingAllowed,
        },
      });
    })();
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
      {
        email: checkout?.email,
        phone:
          checkout?.phone ??
          checkout?.shippingAddress?.phone ??
          checkout?.billingAddress?.phone,
        firstName:
          checkout?.shippingAddress?.firstName ??
          checkout?.billingAddress?.firstName,
        lastName:
          checkout?.shippingAddress?.lastName ??
          checkout?.billingAddress?.lastName,
        city:
          checkout?.shippingAddress?.city ??
          checkout?.billingAddress?.city,
        state:
          checkout?.shippingAddress?.provinceCode ??
          checkout?.shippingAddress?.province ??
          checkout?.billingAddress?.provinceCode ??
          checkout?.billingAddress?.province,
        postalCode:
          checkout?.shippingAddress?.zip ??
          checkout?.billingAddress?.zip,
        country:
          checkout?.shippingAddress?.countryCode ??
          checkout?.shippingAddress?.country ??
          checkout?.billingAddress?.countryCode ??
          checkout?.billingAddress?.country,
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
        {
          email: checkout?.email,
          phone:
            checkout?.phone ??
            checkout?.shippingAddress?.phone ??
            checkout?.billingAddress?.phone,
          firstName:
            checkout?.shippingAddress?.firstName ??
            checkout?.billingAddress?.firstName,
          lastName:
            checkout?.shippingAddress?.lastName ??
            checkout?.billingAddress?.lastName,
          city:
            checkout?.shippingAddress?.city ??
            checkout?.billingAddress?.city,
          state:
            checkout?.shippingAddress?.provinceCode ??
            checkout?.shippingAddress?.province ??
            checkout?.billingAddress?.provinceCode ??
            checkout?.billingAddress?.province,
          postalCode:
            checkout?.shippingAddress?.zip ??
            checkout?.billingAddress?.zip,
          country:
            checkout?.shippingAddress?.countryCode ??
            checkout?.shippingAddress?.country ??
            checkout?.billingAddress?.countryCode ??
            checkout?.billingAddress?.country,
        },
      );
    },
  );
});