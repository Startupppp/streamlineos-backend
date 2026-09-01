import { and, count, eq, inArray, sql } from "drizzle-orm";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../../db/drizzle.types";
import { organizations } from "../../../../db/schema/common/auth";
import {
  PURGE_ADAPTERS,
  type PurgeAdapter,
} from "../../../../db/schema/common/organization-purge";
import { kbArticleChunks } from "../../../../db/schema/support/kb-chunks";
import { storagePendingPurge } from "../../../../db/schema/common/storage-pending-purge";
import {
  enumerateFileKeyColumns,
  collectOrgFileKeys,
} from "../../../storage/storage-key-catalog";
import type { StorageService } from "../../../storage/storage.service";

const OBJECT_DELETE_ATTEMPTS = 3;

export type PurgeAdapterResult = {
  state: "CONFIRMED" | "FAILED" | "NOT_APPLICABLE";
  detail: string;
};

export type PurgeAdapterDef = {
  confirm: (
    orgId: string,
    purgeJobId: string,
    db: Db,
    storage?: StorageService,
  ) => Promise<PurgeAdapterResult>;
};

function failedAdapter(detail: string): PurgeAdapterDef {
  return {
    confirm: async () => ({ state: "FAILED", detail }),
  };
}

export const PURGE_ADAPTER_REGISTRY: Record<PurgeAdapter, PurgeAdapterDef> = {
  database_rows: {
    confirm: async (orgId, _purgeJobId, db) => {
      const [org] = await db
        .select({ id: organizations.id, statusV2: organizations.statusV2 })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!org)
        return {
          state: "CONFIRMED",
          detail: "Organization row absent; no database rows remain",
        };
      if (org.statusV2 === "PURGED")
        return {
          state: "CONFIRMED",
          detail: "Organization row confirms PURGED status",
        };
      if (org.statusV2 === "PURGE_SCHEDULED")
        return {
          state: "CONFIRMED",
          detail:
            "Organization is eligible; the purge orchestrator physically deletes the organization row after all adapters confirm",
        };
      return {
        state: "FAILED",
        detail: `Organization is not purgeable from status ${org.statusV2 ?? "NULL"}`,
      };
    },
  },

  object_storage: {
    confirm: async (orgId, _purgeJobId, db, storage) => {
      if (!storage) {
        return {
          state: "FAILED",
          detail:
            "Storage service not available for automated purge; cannot enumerate or delete object-storage blobs without it",
        };
      }

      let columns: Awaited<ReturnType<typeof enumerateFileKeyColumns>>;
      try {
        columns = await enumerateFileKeyColumns(db);
      } catch (err) {
        return {
          state: "FAILED",
          detail: `Failed to enumerate file-key columns from pg_catalog: ${String(err)}`,
        };
      }

      let keys: string[];
      try {
        keys = await collectOrgFileKeys(db, orgId, columns);
      } catch (err) {
        return {
          state: "FAILED",
          detail: `Failed to collect org file keys: ${String(err)}`,
        };
      }

      if (keys.length === 0) {
        return {
          state: "CONFIRMED",
          detail: "No object-storage keys found for this org; nothing to delete",
        };
      }

      const failedKeys: string[] = [];

      for (const key of keys) {
        try {
          await runInNewTenantTransaction(db, orgId, async (tx) => {
            await tx
              .insert(storagePendingPurge)
              .values({
                orgId,
                storageKey: key,
                purpose: "org-purge",
                status: "pending",
              })
              .onConflictDoUpdate({
                target: [storagePendingPurge.orgId, storagePendingPurge.storageKey],
                set: { status: "pending", lastAttemptedAt: null, failedReason: null },
              });
          });
        } catch (err) {
          failedKeys.push(key);
          continue;
        }

        try {
          let lastError: unknown;
          for (let attempt = 1; attempt <= OBJECT_DELETE_ATTEMPTS; attempt++) {
            try {
              await storage.deleteFile(orgId, key);
              lastError = undefined;
              break;
            } catch (err) {
              lastError = err;
            }
          }
          if (lastError !== undefined) throw lastError;

          if (typeof storage.fileExists === "function" && await storage.fileExists(orgId, key)) {
            throw new Error("object remains after delete verification");
          }
          await runInNewTenantTransaction(db, orgId, async (tx) => {
            await tx
              .update(storagePendingPurge)
              .set({
                status: "confirmed",
                confirmedAt: new Date(),
                lastAttemptedAt: new Date(),
                attemptCount: sql`${storagePendingPurge.attemptCount} + 1`,
              })
              .where(
                and(
                  eq(storagePendingPurge.orgId, orgId),
                  eq(storagePendingPurge.storageKey, key),
                ),
              );
          });
        } catch (err) {
          failedKeys.push(key);
          try {
            await runInNewTenantTransaction(db, orgId, async (tx) => {
              await tx
                .update(storagePendingPurge)
                .set({
                  status: "failed",
                  failedReason: String(err),
                  lastAttemptedAt: new Date(),
                  attemptCount: sql`${storagePendingPurge.attemptCount} + 1`,
                })
                .where(
                  and(
                    eq(storagePendingPurge.orgId, orgId),
                    eq(storagePendingPurge.storageKey, key),
                  ),
                );
            });
          } catch {
          }
        }
      }

      let remaining: string[];
      try {
        remaining = await collectOrgFileKeys(db, orgId, columns);
      } catch (err) {
        return {
          state: "FAILED",
          detail: `Could not verify post-delete state: ${String(err)}`,
        };
      }

      if (remaining.length === 0)
        return {
          state: "CONFIRMED",
          detail: `All ${keys.length} object-storage key(s) deleted and verified absent`,
        };

      return {
        state: "FAILED",
        detail: `${remaining.length} of ${keys.length} key(s) still present after delete; failed keys: ${failedKeys.slice(0, 5).join(", ")}${failedKeys.length > 5 ? ` … and ${failedKeys.length - 5} more` : ""}`,
      };
    },
  },

  cache: {
    confirm: async () => ({
      state: "NOT_APPLICABLE",
      detail:
        "Org-scoped cache keys carry a TTL and are excluded from shared multi-org pools; no explicit cleanup required at purge time",
    }),
  },

  search_index: {
    confirm: async () => ({
      state: "NOT_APPLICABLE",
      detail:
        "Search is Postgres tsvector/GIN over the same rows; no external search client exists in this repo. Search index entries are removed with the underlying rows during the database purge pass.",
    }),
  },

  vector_index: {
    confirm: async (orgId, _purgeJobId, db) => {
      try {
        await runInNewTenantTransaction(db, orgId, async (tx) => {
          await tx.delete(kbArticleChunks).where(eq(kbArticleChunks.orgId, orgId));
        });

        const rows = await runInNewTenantTransaction(db, orgId, async (tx) =>
          tx
            .select({ remaining: count() })
            .from(kbArticleChunks)
            .where(eq(kbArticleChunks.orgId, orgId)),
        );

        const remaining = Number(rows[0]?.remaining ?? 0);

        if (remaining === 0)
          return {
            state: "CONFIRMED",
            detail: "All kb_article_chunks rows for this org deleted and verified absent",
          };

        return {
          state: "FAILED",
          detail: `${remaining} kb_article_chunk row(s) still present after delete; manual inspection required`,
        };
      } catch (err) {
        return { state: "FAILED", detail: `vector_index purge error: ${String(err)}` };
      }
    },
  },

  analytics_copies: failedAdapter(
    "Analytics warehouse client not wired; manual cleanup required before marking CONFIRMED",
  ),

  provider_mirrors: failedAdapter(
    "No Composio client available at purge time to reconcile or disconnect provider accounts in user_integration_connections; manual cleanup required",
  ),

  backups: failedAdapter(
    "Backup system not configured; manual verification required before marking CONFIRMED",
  ),

  audit_evidence: {
    confirm: async () => ({
      state: "NOT_APPLICABLE",
      detail:
        "Audit logs are retained per legal obligation and must not be deleted at purge time",
    }),
  },
};

export { PURGE_ADAPTERS };
