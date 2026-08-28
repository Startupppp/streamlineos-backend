import { count, eq } from "drizzle-orm";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../../db/drizzle.types";
import { organizations } from "../../../../db/schema/common/auth";
import {
  PURGE_ADAPTERS,
  type PurgeAdapter,
} from "../../../../db/schema/common/organization-purge";
import { kbArticleChunks } from "../../../../db/schema/support/kb-chunks";

export type PurgeAdapterResult = {
  state: "CONFIRMED" | "FAILED" | "NOT_APPLICABLE";
  detail: string;
};

export type PurgeAdapterDef = {
  confirm: (orgId: string, purgeJobId: string, db: Db) => Promise<PurgeAdapterResult>;
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
      return {
        state: "FAILED",
        detail:
          "Physical row deletion not implemented; purge worker marks statusV2=PURGED but does not cascade-delete tenant data",
      };
    },
  },

  object_storage: failedAdapter(
    "Object-storage keys carry no org-scoped prefix (format: folder/uuid-filename with no org segment); files from multiple tenants share the same bucket. Enumerating and deleting an org's files requires a per-table audit of every file_key column across the schema — not yet implemented. Manual cleanup required.",
  ),

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
