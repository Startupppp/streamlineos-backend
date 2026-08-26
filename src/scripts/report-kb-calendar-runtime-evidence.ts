import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { ArchitectureEvidenceModule } from "./architecture-evidence.module";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import { forEachOrg } from "../common/tenant/for-each-org";

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return value as Row[];
}

/**
 * Read-only c1/c2 runtime evidence.
 *
 * This deliberately uses the minimal evidence module and a PostgreSQL
 * READ ONLY transaction. It never seeds, updates, deletes, or changes session
 * state beyond the transaction's read-only flag. The result is aggregate
 * evidence only; no page content, user identifiers, or event data is emitted.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ArchitectureEvidenceModule, {
    logger: false,
  });

  try {
    const db = app.get<Db>(DRIZZLE);
    const organizations: Array<{ orgId: string; kb: Row; calendar: Row }> = [];
    const sweep = await forEachOrg(db, "kb-calendar-runtime-evidence", async (tx, orgId) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);

      const [kb] = rows(await tx.execute(sql`
        WITH eligible AS (
          SELECT id, org_id, visibility, project_id, created_by_id
          FROM kb_pages
          WHERE org_id = ${orgId} AND deleted_at IS NULL AND status <> 'archived'
        ),
        index_candidates AS (
          SELECT e.*
          FROM eligible e
          JOIN kb_pages p ON p.id = e.id AND p.org_id = e.org_id
          WHERE p.content_text IS NOT NULL AND trim(p.content_text) <> ''
        ),
        indexed AS (
          SELECT DISTINCT c.page_id
          FROM kb_article_chunks c
          JOIN index_candidates p ON p.id = c.page_id AND p.org_id = c.org_id
          WHERE c.source = 'page_body'
        ),
        acl_mismatches AS (
          SELECT c.id
          FROM kb_article_chunks c
          JOIN kb_pages p ON p.id = c.page_id AND p.org_id = c.org_id
          WHERE c.org_id = ${orgId}
            AND c.source = 'page_body'
            AND (c.page_visibility IS DISTINCT FROM p.visibility
             OR c.page_project_id IS DISTINCT FROM p.project_id
             OR c.page_created_by_id IS DISTINCT FROM p.created_by_id)
        )
        SELECT
          (SELECT count(*) FROM kb_pages WHERE org_id = ${orgId}) AS total_pages,
          (SELECT count(*) FROM eligible) AS eligible_pages,
          (SELECT count(*) FROM index_candidates) AS index_candidate_pages,
          (SELECT count(*) FROM eligible) - (SELECT count(*) FROM index_candidates) AS contentless_eligible_pages,
          (SELECT count(*) FROM indexed) AS indexed_eligible_pages,
          (SELECT count(*) FROM index_candidates e LEFT JOIN indexed i ON i.page_id = e.id WHERE i.page_id IS NULL) AS eligible_without_chunk,
          (SELECT coalesce(array_agg(e.id ORDER BY e.id), ARRAY[]::integer[])
             FROM index_candidates e
             LEFT JOIN indexed i ON i.page_id = e.id
            WHERE i.page_id IS NULL) AS eligible_without_chunk_page_ids,
          (SELECT count(*) FROM acl_mismatches) AS chunk_acl_mismatches,
          (SELECT count(*) FROM kb_article_chunks c LEFT JOIN kb_pages p ON p.id = c.page_id AND p.org_id = c.org_id WHERE c.org_id = ${orgId} AND p.id IS NULL) AS orphan_chunks
      `));

      const [calendar] = rows(await tx.execute(sql`
        WITH known(source_key) AS (
          VALUES ('hr-attendance'), ('hr-holidays'), ('hr-interviews'), ('hr-leaves')
        )
        SELECT
          count(*) AS preference_rows,
          count(DISTINCT (org_id, user_id)) AS preference_scopes,
          count(*) FILTER (WHERE enabled = false) AS disabled_rows,
          count(*) FILTER (WHERE enabled = true) AS enabled_rows,
          count(*) FILTER (WHERE k.source_key IS NULL) AS unknown_source_keys,
          count(*) FILTER (WHERE org_id IS NULL OR user_id IS NULL) AS invalid_owner_rows
        FROM calendar_source_preferences p
        LEFT JOIN known k ON k.source_key = p.source_key
        WHERE p.org_id = ${orgId}
      `));

      organizations.push({ orgId, kb, calendar });
    });

    const sum = (field: string, source: "kb" | "calendar") =>
      organizations.reduce((total, item) => total + Number(item[source][field] ?? 0), 0);

    const evidence = {
      generatedAt: new Date().toISOString(),
      organizations: sweep.organizations,
      succeeded: sweep.succeeded,
      failed: sweep.failed,
      readOnly: true,
      c1: {
        embeddingProviderConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
        totalPages: sum("total_pages", "kb"),
        eligiblePages: sum("eligible_pages", "kb"),
        indexCandidatePages: sum("index_candidate_pages", "kb"),
        contentlessEligiblePages: sum("contentless_eligible_pages", "kb"),
        indexedEligiblePages: sum("indexed_eligible_pages", "kb"),
        eligibleWithoutChunk: sum("eligible_without_chunk", "kb"),
        targets: organizations.flatMap(({ orgId, kb }) => {
          const pageIds = Array.isArray(kb.eligible_without_chunk_page_ids)
            ? kb.eligible_without_chunk_page_ids.map(Number)
            : [];
          return pageIds.length > 0 ? [{ orgId, pageIds }] : [];
        }),
        chunkAclMismatches: sum("chunk_acl_mismatches", "kb"),
        orphanChunks: sum("orphan_chunks", "kb"),
      },
      c2: {
        preferenceRows: sum("preference_rows", "calendar"),
        preferenceScopes: sum("preference_scopes", "calendar"),
        disabledRows: sum("disabled_rows", "calendar"),
        enabledRows: sum("enabled_rows", "calendar"),
        unknownSourceKeys: sum("unknown_source_keys", "calendar"),
        invalidOwnerRows: sum("invalid_owner_rows", "calendar"),
      },
      interpretation: {
        c1: [
          "eligibleWithoutChunk counts only lifecycle-eligible pages with non-empty contentText and no page_body chunk, matching indexPage's data eligibility",
          "targets contains only tenant and page identifiers needed to scope an operator-approved backfill; it emits no page content or user identifiers",
          "eligibleWithoutChunk=0 is an achievable coverage invariant only while embeddingProviderConfigured=true; provider availability during a run remains an external runtime prerequisite",
          "contentlessEligiblePages are lifecycle-eligible but intentionally make no embedding call",
          "chunkAclMismatches=0 is required for page/chunk visibility metadata parity",
          "orphanChunks=0 is required for referential retrieval hygiene",
          "These are read-only database invariants; they do not replace a seeded end-to-end viewer parity run.",
        ],
        c2: [
          "unknownSourceKeys=0 and invalidOwnerRows=0 are required for preference integrity",
          "preferenceScopes proves persisted rows are keyed by both organization and user",
          "This command does not mutate preferences and does not claim HTTP/controller proof.",
        ],
      },
    };

    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
