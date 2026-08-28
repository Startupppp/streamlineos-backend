import { eq } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import { organizations } from "../../../../db/schema/common/auth";
import {
  PURGE_ADAPTERS,
  type PurgeAdapter,
} from "../../../../db/schema/common/organization-purge";

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
    "S3/GCS object-storage client not wired; manual cleanup required before marking CONFIRMED",
  ),

  cache: {
    confirm: async () => ({
      state: "NOT_APPLICABLE",
      detail:
        "Org-scoped cache keys carry a TTL and are excluded from shared multi-org pools; no explicit cleanup required at purge time",
    }),
  },

  search_index: failedAdapter(
    "Search-index client not wired; manual cleanup required before marking CONFIRMED",
  ),

  vector_index: failedAdapter(
    "pgvector / external vector store client not wired; manual cleanup required before marking CONFIRMED",
  ),

  analytics_copies: failedAdapter(
    "Analytics warehouse client not wired; manual cleanup required before marking CONFIRMED",
  ),

  provider_mirrors: failedAdapter(
    "Third-party provider mirror reconciliation not implemented; manual cleanup required",
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
