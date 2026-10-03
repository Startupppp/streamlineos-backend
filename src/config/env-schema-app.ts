import { z } from "zod";
import { deploymentSecret, emptyToUndefined, optionalEmail, optionalUrl } from "./env-schema-helpers";

export const appEnvShape = {
    EMAIL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["zeptomail", "resend"]).optional()),
    ZEPTOMAIL_API_URL: optionalUrl,
    ZEPTOMAIL_TOKEN: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(40, "ZEPTOMAIL_TOKEN looks truncated").optional(),
    ),
    /** Absent, the ZeptoMail webhook rejects every delivery — it fails closed, not open. */
    ZEPTOMAIL_WEBHOOK_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    RESEND_WEBHOOK_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    /** Below 32 characters the unsubscribe signer refuses to mint a token at all. */
    UNSUBSCRIBE_TOKEN_SECRET: deploymentSecret,
    EMAIL_FROM_ADDRESS: optionalEmail,
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
    /** Below 100ms the cache factory throws at boot; bound here so the error appears in the aggregated env-validation report. */
    REDIS_COMMAND_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(100).optional()),
    TURNSTILE_SECRET_KEY: z.string().optional(),
    TURNSTILE_DISABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    ABLY_API_KEY: z.string().optional(),
    ENCRYPTION_KEY: z
      .string()
      .min(32, "ENCRYPTION_KEY must be at least 32 characters — it protects PII at rest"),
    AI_CONFIRMATION_SECRET: deploymentSecret,
    COMPOSIO_API_KEY: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_OUTLOOK: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_GMAIL: z.string().optional(),
    /**
     * E6 — which sales-channel adapter this deployment runs.
     *
     * Absent or `none` means no adapter is registered and nothing outbound
     * happens: every channel resolves to the manual adapter and a refetch
     * reports `NO_ADAPTER` without opening a socket. `fake` registers the
     * deterministic development adapter, which contacts no marketplace.
     *
     * A real marketplace adapter does not belong here — third-party
     * connectivity goes through Composio in the `integrations` module, and its
     * credentials live on the connected account, never in this file or our
     * database (root CLAUDE.md §5).
     */
    INV_CHANNEL_ADAPTER: z.preprocess(
      emptyToUndefined,
      z.enum(["none", "fake", "shopify"]).optional(),
    ),
    /**
     * INV-27 — the Shopify Admin API access token, when `INV_CHANNEL_ADAPTER=shopify`.
     *
     * Deployment configuration for the same reason the webhook secret above is:
     * a store's credential is a provider credential and §5 keeps those out of
     * our database. It is also this integration's clearest limit — one token is
     * one store, so a multi-tenant deployment needs the token to arrive from a
     * Composio connected account instead, and `ComposioGateway` has no Shopify
     * toolkit yet. Unset means the adapter is inert: it refuses every call with
     * `NO_CREDENTIAL` rather than sending a request with a blank header and
     * reading the 401 as something about the order.
     */
    INV_CHANNEL_SHOPIFY_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    /** Pinned, never floating — Shopify removes an API version after a year. */
    INV_CHANNEL_SHOPIFY_API_VERSION: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    /** How long to wait for the store. Unset uses the adapter's 15s default. */
    INV_CHANNEL_SHOPIFY_TIMEOUT_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    /**
     * E6 — the HMAC secret an inbound channel webhook is verified against.
     *
     * Deployment configuration rather than a tenant column, because a store's
     * shared secret is a provider credential and §5 keeps those out of our
     * database. Absent means the corresponding channel type refuses every
     * delivery — an unconfigured secret is never "skip verification".
     */
    INV_CHANNEL_WEBHOOK_SECRET_SHOPIFY: z.preprocess(emptyToUndefined, z.string().optional()),
    INV_CHANNEL_WEBHOOK_SECRET_WOOCOMMERCE: z.preprocess(emptyToUndefined, z.string().optional()),
    INV_CHANNEL_WEBHOOK_SECRET_DEFAULT: z.preprocess(emptyToUndefined, z.string().optional()),
    SHOPIFY_SANDBOX_TOKEN: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    DELHIVERY_SANDBOX_TOKEN: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    /** Guards POST /webhooks/calendar/provider (@Public). Unset = receiver not deployed (it 503s deliveries). Min 32 chars — the only gate on that public endpoint. */
    CALENDAR_PROVIDER_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().min(32, "CALENDAR_PROVIDER_WEBHOOK_SECRET must be at least 32 characters — it is the only check on the public calendar webhook endpoint.").optional()),
    /** "1" re-arms live email under NODE_ENV=test, which is off by default so a suite cannot send real mail. Anything else, including unset, keeps the provider clients null. */
    EMAIL_ALLOW_LIVE_SEND: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).optional()),
    EMAIL_FROM_NAME: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    EMAIL_APP_URL: optionalUrl,
    NOREPLY_EMAIL: optionalEmail,
    RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
};
