import { z } from "zod";
import { poolEnvShape } from "../db/pool.config";
import { REGION_KEY_PATTERN } from "../common/region/region.config";
import { deploymentSecret, emptyToUndefined, optionalEmail, optionalUrl, databaseUrl, optionalDatabaseUrl } from "./env-schema-helpers";

export const databaseEnvShape = {
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(1500),
    DATABASE_URL: databaseUrl("DATABASE_URL"),
    /** The RLS-enforced application role. Falling back to DATABASE_URL bypasses every tenant policy. */
    APP_DATABASE_URL: optionalDatabaseUrl("APP_DATABASE_URL"),
    /** Session-mode connection for migrations and db:verify-rls; only Neon can be derived automatically. */
    DIRECT_DATABASE_URL: optionalDatabaseUrl("DIRECT_DATABASE_URL"),
    /** Setup-only inputs consumed by db:bootstrap-role; runtime traffic uses APP_DATABASE_URL. */
    APP_DB_ROLE: z.preprocess(
      emptyToUndefined,
      z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/i, "APP_DB_ROLE must be a PostgreSQL identifier").optional(),
    ),
    APP_DB_PASSWORD: z.preprocess(
      emptyToUndefined,
      z.string().min(16, "APP_DB_PASSWORD must be at least 16 characters").optional(),
    ),
    APP_DB_SCHEMA: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    /** The region new organisations are placed in; the primary inherits the flat DATABASE_URL and R2_* vars. */
    PRIMARY_REGION: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(REGION_KEY_PATTERN, "PRIMARY_REGION is lowercase letters, digits and dashes")
        .optional(),
    ),
    /** Release identifier stamped onto every error report and span. */
    APP_RELEASE: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Comma-separated user ids holding the vendor's platform-only capabilities (global blog administration). Unset means nobody. */
    PLATFORM_ADMIN_USER_IDS: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Comma-separated regions this deployment serves; each secondary needs its own REGION_<KEY>_APP_DATABASE_URL. */
    REGION_KEYS: z.preprocess(emptyToUndefined, z.string().optional()),
    /** The cell this deployment is. Defaults to `legacy-1`, the pre-cell production deployment. */
    CELL_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    DATABASE_SHARD: z.preprocess(emptyToUndefined, z.string().optional()),
    SEARCH_CLUSTER: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Signs the placement a session carries so a cell verifies it rather than trusting its cache; falls back to BACKEND_JWT_SECRET. */
    PLACEMENT_SIGNING_KEY: z.preprocess(emptyToUndefined, deploymentSecret),
    PLACEMENT_SIGNING_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    PLACEMENT_SIGNING_KEY_PREVIOUS: z.preprocess(emptyToUndefined, deploymentSecret),
    PLACEMENT_SIGNING_KEY_PREVIOUS_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    ...poolEnvShape,
    BACKEND_JWT_SECRET: z
      .string()
      .min(
        44,
        "BACKEND_JWT_SECRET must be at least 44 characters (256-bit base64)",
      ),
    /** Ed25519 keypair(s) for asymmetric JWT signing. JSON array of {kid, privateKey (JWK), publicKey (JWK)}. */
    AUTH_SIGNING_KEYS: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Shared with the frontend NextAuth instance; used by the backend to verify session-exchange proofs. Must match NEXTAUTH_SECRET in frontend/.env. */
    NEXTAUTH_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    /** Optional HMAC key for pseudonymising public-roadmap voter IPs; falls back to BACKEND_JWT_SECRET. */
    VOTE_IP_SALT: z.preprocess(emptyToUndefined, deploymentSecret),
    PORTAL_JWT_SECRET: z
      .string()
      .min(
        44,
        "PORTAL_JWT_SECRET must be at least 44 characters (256-bit base64)",
      ),
    CORS_ORIGINS: z.string().min(1, "CORS_ORIGINS is required"),
    APP_URL: z.string().url("APP_URL must be a valid URL"),
    /**
     * This API's own public origin, for links a MAIL CLIENT must call rather
     * than a browser.
     *
     * `APP_URL` is the web app, and every other email link is a page there. RFC
     * 8058 one-click unsubscribe is the exception: the mail client POSTs the
     * URL itself, so it has to reach a route that exists on the API. Optional,
     * and when it is unset the `List-Unsubscribe` headers are omitted entirely
     * rather than pointed somewhere that cannot answer.
     */
    PUBLIC_API_URL: optionalUrl,
    CRON_SECRET: deploymentSecret,
    INTERNAL_API_SECRET: deploymentSecret,
    CONTACT_NOTIFICATION_EMAIL: optionalEmail,
    WAITLIST_NOTIFICATION_EMAILS: z.preprocess(emptyToUndefined, z.string().trim().optional()),
};
