import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  kbEvents,
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  supportKnowledgeGaps,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { SupportKnowledgeGapStatus } from "../../../../db/schema/support/support-kb-gap";

export type GapRow = typeof supportKnowledgeGaps.$inferSelect;

const CLUSTER_SIMILARITY_THRESHOLD = 0.75;
const KB_OWNER_PERMISSION = "kb:articles:manage";

/**
 * The primitives knowledge-gap detection is built from, lifted out of
 * `support-kb-gap.service.ts` unchanged.
 *
 * Every one of them reached for `this.db` and nothing else — so the executor
 * arrives as a parameter. `SupportKbGapDetectionService` keeps the detection
 * orchestration (clustering, search gaps, upsert); `SupportKbGapService` uses
 * `findKbOwners` and `buildEvidenceText` when it drafts an article for a gap.
 */
export async function clusterTicketEmbeddings(
    db: Db,orgId: string) {
    const results = await db.execute(
      sql`
        SELECT
          a.ticket_id AS representative_ticket_id,
          a.ticket_id AS anchor_id,
          array_agg(DISTINCT b.ticket_id ORDER BY b.ticket_id) AS cluster_ids,
          t.title AS representative_question
        FROM support_ticket_embeddings a
        JOIN support_ticket_embeddings b
          ON b.org_id = a.org_id
          AND b.ticket_id != a.ticket_id
          AND (a.embedding <=> b.embedding) < ${1 - CLUSTER_SIMILARITY_THRESHOLD}
        JOIN support_tickets t
          ON t.id = a.ticket_id AND t.org_id = a.org_id
        JOIN support_tickets bt
          ON bt.id = b.ticket_id
          AND (bt.status = 'OPEN' OR bt.status = 'IN_PROGRESS')
        WHERE a.org_id = ${orgId}
          AND (t.status = 'OPEN' OR t.status = 'IN_PROGRESS')
        GROUP BY a.ticket_id, t.title
        HAVING count(DISTINCT b.ticket_id) >= 1
      `,
    );

    const seen = new Set<number>();
    const clusters: Array<{
      representativeTicketId: number;
      representativeQuestion: string;
      ticketIds: number[];
    }> = [];

    for (const row of results) {
      const repId = Number(row["representative_ticket_id"]);
      const ids = (row["cluster_ids"] as number[]).map(Number);
      const allIds = [repId, ...ids].sort((a, b) => a - b);
      const minId = allIds[0] ?? repId;

      if (seen.has(minId)) continue;
      for (const id of allIds) seen.add(id);

      clusters.push({
        representativeTicketId: minId,
        representativeQuestion: String(row["representative_question"] ?? ""),
        ticketIds: allIds,
      });
    }

    return clusters;
  }

export async function getSearchGaps(
    db: Db,orgId: string) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return db
      .select({
        query: kbEvents.query,
        count: sql<number>`count(*)::int`,
        lastOccurredAt: sql<Date>`max(${kbEvents.occurredAt})`,
      })
      .from(kbEvents)
      .where(
        and(
          eq(kbEvents.orgId, orgId),
          eq(kbEvents.eventType, "search_no_results"),
          gte(kbEvents.occurredAt, since),
        ),
      )
      .groupBy(kbEvents.query)
      .orderBy(desc(sql`count(*)`))
      .limit(20);
  }

export interface GapEvidence {
  searchQueries: Array<{ query: string; count: number }>;
  relatedTicketIds: number[];
}

export interface GapUpsertEntry {
  clusterKey: string;
  representativeQuestion: string;
  ticketCount: number;
  sampleTicketIds: number[];
  evidence: GapEvidence;
}

export interface GapUpsertCounts {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * How many gaps go into one statement.
 *
 * A gap row binds 7 parameters, so the postgres-js ceiling of 65,534 would be
 * reached at roughly 9,360 rows in a single multi-row `VALUES`. Nothing upstream
 * bounds the cluster count (see `clusterTicketEmbeddings` — no `LIMIT`), so the
 * chunk is not a nicety: without it, batching would turn an org with a large
 * open-ticket set from "slow" into "throws". 500 is the same chunk
 * `common/db/bulk-update.ts` uses.
 */
export const GAP_UPSERT_CHUNK = 500;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Upsert a whole detection pass in two statements per chunk instead of two per
 * gap.
 *
 * The per-gap predecessor was read-then-write: one `findFirst` to decide insert
 * vs update, then the write. Called once per cluster it cost `2N` round trips on
 * the one pooled connection the sweep holds, and `ticketClusters` is unbounded —
 * so the cost grew with the organisation's open-ticket count.
 *
 * Three things the per-row version did that this has to keep doing, spelled out
 * because each is easy to lose in a batch:
 *
 *   1. **The status gate.** A gap that is no longer OPEN or DRAFTED is left
 *      alone — a DISMISSED gap must not be resurrected by the next sweep. That
 *      is `setWhere` on the conflict clause, so it holds even for a row whose
 *      status changed between the pre-read and the write.
 *   2. **The update does NOT write `representativeQuestion` or `status`.** Only
 *      `ticketCount`, `sampleTicketIds`, `evidence` and `updatedAt`. A `set:`
 *      built naively from the inserted columns would rewrite a gap's question
 *      and reset a DRAFTED row to OPEN.
 *   3. **created / updated / skipped counts**, which the caller returns to the
 *      cron job. They come from the pre-read partition rather than from
 *      `.returning()`, so they do not depend on `xmax` or on any system column.
 *
 * The counts are a best-effort observation, not a guarantee: a row created by a
 * concurrent sweep between the pre-read and the write is counted here as
 * "created" and lands as an update. The DATA is still correct in that race —
 * which is an improvement on the per-row version, where two concurrent sweeps
 * both read "absent" and both INSERTed, and the loser got an unhandled 23505.
 */
export async function upsertGaps(
  db: Db,
  orgId: string,
  entries: readonly GapUpsertEntry[],
): Promise<GapUpsertCounts> {
  // Last writer wins per key. A single multi-row ON CONFLICT DO UPDATE raises
  // 21000 ("cannot affect row a second time") if two rows share the conflict
  // target, and unlike the per-row version this form is sensitive to it. The
  // two producers cannot currently collide — cluster keys are deduped by
  // `seen` and search keys are GROUP BY query, and the prefixes differ — so
  // this is insurance against the third producer, not a live fix.
  const byKey = new Map<string, GapUpsertEntry>();
  for (const entry of entries) byKey.set(entry.clusterKey, entry);
  const deduped = [...byKey.values()];
  if (deduped.length === 0) return { created: 0, updated: 0, skipped: 0 };

  const statusByKey = new Map<string, string>();
  for (const chunk of chunked(deduped, GAP_UPSERT_CHUNK)) {
    const rows = await db.query.supportKnowledgeGaps.findMany({
      where: and(
        eq(supportKnowledgeGaps.orgId, orgId),
        inArray(
          supportKnowledgeGaps.clusterKey,
          chunk.map((entry) => entry.clusterKey),
        ),
      ),
      columns: { clusterKey: true, status: true },
    });
    for (const row of rows) statusByKey.set(row.clusterKey, row.status);
  }

  const writable: GapUpsertEntry[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const entry of deduped) {
    const status = statusByKey.get(entry.clusterKey);
    if (status === undefined) {
      created++;
      writable.push(entry);
    } else if (
      status === SupportKnowledgeGapStatus.OPEN ||
      status === SupportKnowledgeGapStatus.DRAFTED
    ) {
      updated++;
      writable.push(entry);
    } else {
      skipped++;
    }
  }

  for (const chunk of chunked(writable, GAP_UPSERT_CHUNK)) {
    await db
      .insert(supportKnowledgeGaps)
      .values(
        chunk.map((entry) => ({
          orgId,
          clusterKey: entry.clusterKey,
          representativeQuestion: entry.representativeQuestion,
          ticketCount: entry.ticketCount,
          sampleTicketIds: entry.sampleTicketIds,
          evidence: entry.evidence,
          status: SupportKnowledgeGapStatus.OPEN,
        })),
      )
      .onConflictDoUpdate({
        target: [supportKnowledgeGaps.orgId, supportKnowledgeGaps.clusterKey],
        set: {
          ticketCount: sql`excluded.ticket_count`,
          sampleTicketIds: sql`excluded.sample_ticket_ids`,
          evidence: sql`excluded.evidence`,
          updatedAt: new Date(),
        },
        setWhere: inArray(supportKnowledgeGaps.status, [
          SupportKnowledgeGapStatus.OPEN,
          SupportKnowledgeGapStatus.DRAFTED,
        ]),
      });
  }

  return { created, updated, skipped };
}

export async function findKbOwners(
    db: Db,orgId: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ userId: organizationMembers.userId })
      .from(roleAssignments)
      .innerJoin(
        rolePermissionGrants,
        and(
          eq(rolePermissionGrants.roleId, roleAssignments.roleId),
          eq(rolePermissionGrants.orgId, orgId),
          eq(rolePermissionGrants.permissionKey, KB_OWNER_PERMISSION),
        ),
      )
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        ),
      )
      .where(eq(roleAssignments.orgId, orgId))
      .limit(3);

    return rows.map((r) => r.userId);
  }

export function buildEvidenceText(gap: GapRow): string {
    const evidence = gap.evidence as {
      searchQueries: Array<{ query: string; count: number }>;
      relatedTicketIds: number[];
    } | null;
    const parts: string[] = [];
    if (evidence?.searchQueries?.length) {
      parts.push(
        `Search queries with no results:\n${evidence.searchQueries.map((q) => `- "${q.query}" (${q.count}x)`).join("\n")}`,
      );
    }
    if (evidence?.relatedTicketIds?.length) {
      parts.push(`Related ticket count: ${evidence.relatedTicketIds.length}`);
    }
    return parts.join("\n\n") || "No additional evidence";
  }
