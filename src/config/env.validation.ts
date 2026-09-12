import { z } from "zod";
import { AWS_RDS_HOST, endpointIdentity, decodedUsername, parseDatabaseUrl } from "./env-schema-helpers";
import { databaseEnvShape } from "./env-schema-database";
import { appEnvShape } from "./env-schema-app";
import { providerEnvShape } from "./env-schema-providers";
import { workerEnvShape } from "./env-schema-workers";

const baseSchema = z.object({
  ...databaseEnvShape,
  ...appEnvShape,
  ...providerEnvShape,
  ...workerEnvShape,
});

/** The schema's own key list, so a coverage test need not restate it. */
export const CONFIG_VARIABLE_NAMES: string[] = Object.keys(baseSchema.shape);

const schema = baseSchema
  .superRefine((config, context) => {
    const owner = parseDatabaseUrl(config.DATABASE_URL);
    const app = config.APP_DATABASE_URL ? parseDatabaseUrl(config.APP_DATABASE_URL) : null;
    const direct = config.DIRECT_DATABASE_URL ? parseDatabaseUrl(config.DIRECT_DATABASE_URL) : null;

    if (owner && app) {
      if (owner.username === app.username) {
        context.addIssue({
          code: "custom",
          path: ["APP_DATABASE_URL"],
          message: "APP_DATABASE_URL must use a different database user from DATABASE_URL so RLS cannot be bypassed",
        });
      }
      if (endpointIdentity(owner) !== endpointIdentity(app)) {
        context.addIssue({
          code: "custom",
          path: ["APP_DATABASE_URL"],
          message: "APP_DATABASE_URL must target the same database and port as DATABASE_URL",
        });
      }
      const expectedRole = config.APP_DB_ROLE ?? "streamline_app";
      if (decodedUsername(app) !== expectedRole) {
        context.addIssue({
          code: "custom",
          path: ["APP_DATABASE_URL"],
          message: `APP_DATABASE_URL username must match APP_DB_ROLE (${expectedRole})`,
        });
      }
    }

    const replica = config.DB_REPLICA_URL ? parseDatabaseUrl(config.DB_REPLICA_URL) : null;
    if (app && replica) {
      if (endpointIdentity(app) !== endpointIdentity(replica)) {
        context.addIssue({
          code: "custom",
          path: ["DB_REPLICA_URL"],
          message: "DB_REPLICA_URL must be a reader endpoint for the same database as APP_DATABASE_URL",
        });
      }
      if (app.username !== replica.username) {
        context.addIssue({
          code: "custom",
          path: ["DB_REPLICA_URL"],
          message: "DB_REPLICA_URL must use the same restricted application role as APP_DATABASE_URL",
        });
      }
    }

    if (owner && direct) {
      if (endpointIdentity(owner) !== endpointIdentity(direct) || owner.username !== direct.username) {
        context.addIssue({
          code: "custom",
          path: ["DIRECT_DATABASE_URL"],
          message: "DIRECT_DATABASE_URL must target the same database as DATABASE_URL using the owner user",
        });
      }
    }

    /*
      ACC-14. `COMPLIANCE_TRANSPORT=irp` is a claim that this deployment files
      invoices with the GST authority, and it is only true with all five
      credentials. A partial set fails here, in every environment, rather than at
      the first filing: the alternative is a node that starts, advertises a live
      transport on the compliance screen, and leaves every reportable document
      `pending` — the silent half of the failure `compliance-honesty.spec.ts`
      exists to prevent. Checked before the production-only block below on
      purpose, because a developer who sets this wants to know now.
    */
    if (config.COMPLIANCE_TRANSPORT === "irp") {
      const missing = (
        [
          "COMPLIANCE_IRP_URL",
          "COMPLIANCE_IRP_CLIENT_ID",
          "COMPLIANCE_IRP_CLIENT_SECRET",
          "COMPLIANCE_IRP_USERNAME",
          "COMPLIANCE_IRP_PASSWORD",
        ] as const
      ).filter((variableName) => !config[variableName]);

      if (missing.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["COMPLIANCE_TRANSPORT"],
          message:
            `COMPLIANCE_TRANSPORT=irp files documents with a tax authority and needs every ` +
            `credential. Missing: ${missing.join(", ")}. Use COMPLIANCE_TRANSPORT=none until the ` +
            `whole set is in place — a partial one files nothing and says nothing.`,
        });
      }
    }

    /*
      INV-27. `INV_CHANNEL_ADAPTER=shopify` is a claim that this deployment talks
      to a real store, and it is only true with a token. Checked in every
      environment rather than only in production, and for the mirror of the
      reason `fake` is refused there: a deployment that says it is connected and
      is not leaves every stock push, order import and ship confirm failing into
      the dead-letter box with `NO_CREDENTIAL`, which looks like a marketplace
      outage rather than a missing line in a deploy config.
    */
    if (config.INV_CHANNEL_ADAPTER === "shopify" && !config.INV_CHANNEL_SHOPIFY_ACCESS_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["INV_CHANNEL_ADAPTER"],
        message:
          "INV_CHANNEL_ADAPTER=shopify needs INV_CHANNEL_SHOPIFY_ACCESS_TOKEN. Without it the adapter " +
          "refuses every call and every channel job dead-letters. Use `none` until the token is in place.",
      });
    }

    if (config.NODE_ENV !== "production") return;
    for (const variableName of [
      "CRON_SECRET",
      "INTERNAL_API_SECRET",
      "CONTACT_NOTIFICATION_EMAIL",
    ] as const) {
      if (config[variableName]) continue;
      context.addIssue({
        code: "custom",
        path: [variableName],
        message: `${variableName} is required in production`,
      });
    }

    if (!config.APP_DATABASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["APP_DATABASE_URL"],
        message:
          "APP_DATABASE_URL is required in production — without it the app connects as the database owner, which has BYPASSRLS and silently disables every tenant isolation policy. Provision the role with `pnpm db:bootstrap-role`.",
      });
    }

    const iamAuth = config.DB_IAM_AUTH === true;

    if (!iamAuth && owner && AWS_RDS_HOST.test(owner.hostname) && !owner.password)
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL must include the RDS password; set DB_IAM_AUTH=true to use IAM database authentication instead",
      });

    if (!iamAuth && app && AWS_RDS_HOST.test(app.hostname) && !app.password)
      context.addIssue({
        code: "custom",
        path: ["APP_DATABASE_URL"],
        message: "APP_DATABASE_URL must include the application-role password; set DB_IAM_AUTH=true to use IAM database authentication instead",
      });

    // INV-27. `fake` answers every marketplace snapshot with a quantity derived
    // from a hash of the SKU. Those numbers are not discarded: they are written
    // to `inv_channel_snapshot_diffs`, served to an operator at
    // `GET /inventory/channels/:id/snapshot-differences`, and — where the
    // channel's policy is ALLOW_ADJUSTMENT — acceptable straight into
    // `inv_stock_transactions`. A boot-time `logger.warn` was the entire
    // safeguard, and a warning in a log nobody is reading is not one. Refusing
    // to start is, and the failure is at boot rather than at the first
    // reconciliation, which is the difference between a deployment that never
    // happens and stock corrected against a number nobody sent.
    if (config.INV_CHANNEL_ADAPTER === "fake") {
      context.addIssue({
        code: "custom",
        path: ["INV_CHANNEL_ADAPTER"],
        message:
          "INV_CHANNEL_ADAPTER=fake is forbidden in production. The fake adapter invents stock quantities from a hash of the SKU, and those quantities are presentable as a marketplace's own count and acceptable into the stock ledger. Use `none` until a real channel integration exists.",
      });
    }
  });

export type AppConfig = z.infer<typeof schema> & { corsOrigins: string[] };

export function validateEnv(
  source: Record<string, unknown> = process.env,
): AppConfig {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[env] Validation failed:\n${issues}`);
  }
  const corsOrigins = result.data.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { ...result.data, corsOrigins };
}
