import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { ArchitectureEvidenceModule } from "./architecture-evidence.module";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";

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
    const evidence = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);

      const [kb] = rows(await tx.execute(sql`
        WITH eligible AS (
          SELECT id, org_id, visibility, project_id, created_by_id
          FROM kb_pages
          WHERE deleted_at IS NULL AND status <> 'archived'
        ),
        indexed AS (
          SELECT DISTINCT c.page_id
          FROM kb_article_chunks c
          JOIN eligible p ON p.id = c.page_id AND p.org_id = c.org_id
        ),
        acl_mismatches AS (
          SELECT c.id
          FROM kb_article_chunks c
          JOIN kb_pages p ON p.id = c.page_id AND p.org_id = c.org_id
          WHERE c.page_visibility IS DISTINCT FROM p.visibility
             OR c.page_project_id IS DISTINCT FROM p.project_id
             OR c.page_created_by_id IS DISTINCT FROM p.created_by_id
        )
        SELECT
          (SELECT count(*) FROM kb_pages) AS total_pages,
          (SELECT count(*) FROM eligible) AS eligible_pages,
          (SELECT count(*) FROM indexed) AS indexed_eligible_pages,
          (SELECT count(*) FROM eligible e LEFT JOIN indexed i ON i.page_id = e.id WHERE i.page_id IS NULL) AS eligible_without_chunk,
          (SELECT count(*) FROM acl_mismatches) AS chunk_acl_mismatches,
          (SELECT count(*) FROM kb_article_chunks c LEFT JOIN kb_pages p ON p.id = c.page_id AND p.org_id = c.org_id WHERE p.id IS NULL) AS orphan_chunks
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
      `));

      const [dbInfo] = rows(await tx.execute(sql`
        SELECT current_database() AS database_name, current_setting('transaction_read_only') AS transaction_read_only
      `));

      return {
        generatedAt: new Date().toISOString(),
        database: dbInfo,
        c1: kb,
        c2: calendar,
        interpretation: {
          c1: [
            "eligible_without_chunk=0 is required for complete index coverage of live pages",
            "chunk_acl_mismatches=0 is required for page/chunk visibility metadata parity",
            "orphan_chunks=0 is required for referential retrieval hygiene",
            "These are read-only database invariants; they do not replace a seeded end-to-end viewer parity run.",
          ],
          c2: [
            "unknown_source_keys=0 and invalid_owner_rows=0 are required for preference integrity",
            "preference_scopes proves persisted rows are keyed by both organization and user",
            "This command does not mutate preferences and does not claim HTTP/controller proof.",
          ],
        },
      };
    });

    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
