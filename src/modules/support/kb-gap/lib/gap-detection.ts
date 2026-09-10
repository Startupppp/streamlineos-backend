import { and, desc, eq, gte, sql } from "drizzle-orm";
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
 * All five were private with no caller outside that service, and every one of
 * them reached for `this.db` and nothing else — so the executor arrives as a
 * parameter and the rest of the service keeps the orchestration.
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

export async function upsertGap(
    db: Db,
    orgId: string,
    clusterKey: string,
    representativeQuestion: string,
    data: {
      ticketCount: number;
      sampleTicketIds: number[];
      evidence: { searchQueries: Array<{ query: string; count: number }>; relatedTicketIds: number[] };
    },
  ): Promise<"created" | "updated" | "skipped"> {
    const existing = await db.query.supportKnowledgeGaps.findFirst({
      where: and(
        eq(supportKnowledgeGaps.orgId, orgId),
        eq(supportKnowledgeGaps.clusterKey, clusterKey),
      ),
      columns: { id: true, status: true },
    });

    if (existing) {
      if (
        existing.status !== SupportKnowledgeGapStatus.OPEN &&
        existing.status !== SupportKnowledgeGapStatus.DRAFTED
      ) {
        return "skipped";
      }
      await db
        .update(supportKnowledgeGaps)
        .set({
          ticketCount: data.ticketCount,
          sampleTicketIds: data.sampleTicketIds,
          evidence: data.evidence,
          updatedAt: new Date(),
        })
        .where(and(eq(supportKnowledgeGaps.id, existing.id), eq(supportKnowledgeGaps.orgId, orgId)));
      return "updated";
    }

    await db.insert(supportKnowledgeGaps).values({
      orgId,
      clusterKey,
      representativeQuestion,
      ticketCount: data.ticketCount,
      sampleTicketIds: data.sampleTicketIds,
      evidence: data.evidence,
      status: SupportKnowledgeGapStatus.OPEN,
    });
    return "created";
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
