import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { kbEvents, supportKnowledgeGaps, supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { logger } from "../../../common/logger/logger.service";
import { SupportKnowledgeGapStatus } from "../../../db/schema/support/support-kb-gap";

const CLUSTER_SIMILARITY_THRESHOLD = 0.75;

@Injectable()
export class SupportKbGapDetectionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async detectGaps(orgId: string): Promise<{ created: number; updated: number }> {
    const ticketClusters = await this.clusterTicketEmbeddings(orgId);
    const searchGaps = await this.getSearchGaps(orgId);

    let created = 0;
    let updated = 0;

    for (const cluster of ticketClusters) {
      const clusterKey = `cluster:${cluster.representativeTicketId}`;
      const result = await this.upsertGap(orgId, clusterKey, cluster.representativeQuestion, {
        ticketCount: cluster.ticketIds.length,
        sampleTicketIds: cluster.ticketIds.slice(0, 10),
        evidence: { searchQueries: [], relatedTicketIds: cluster.ticketIds },
      });
      if (result === "created") created++;
      else if (result === "updated") updated++;
    }

    for (const gap of searchGaps) {
      if (!gap.query) continue;
      const clusterKey = `search:${gap.query}`;
      const result = await this.upsertGap(orgId, clusterKey, gap.query, {
        ticketCount: gap.count,
        sampleTicketIds: [],
        evidence: { searchQueries: [{ query: gap.query, count: gap.count }], relatedTicketIds: [] },
      });
      if (result === "created") created++;
      else if (result === "updated") updated++;
    }

    return { created, updated };
  }

  async runDetectAllOrgs(): Promise<{ processed: number; errors: number }> {
    let processed = 0;
    let errors = 0;

    await forEachOrg(this.db, "support-kb-gap-detect", async (tx, orgId) => {
      const [hasOpenTicket] = await tx
        .select({ id: supportTickets.id })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.orgId, orgId),
            or(eq(supportTickets.status, "OPEN"), eq(supportTickets.status, "IN_PROGRESS")),
          ),
        )
        .limit(1);
      if (!hasOpenTicket) return;

      try {
        await this.detectGaps(orgId);
        processed++;
      } catch (err: unknown) {
        errors++;
        logger.error("support kb-gap detect failed for org", {
          orgId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return { processed, errors };
  }

  private async clusterTicketEmbeddings(orgId: string) {
    const results = await this.db.execute(
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

  private async getSearchGaps(orgId: string) {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.db
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

  private async upsertGap(
    orgId: string,
    clusterKey: string,
    representativeQuestion: string,
    data: {
      ticketCount: number;
      sampleTicketIds: number[];
      evidence: { searchQueries: Array<{ query: string; count: number }>; relatedTicketIds: number[] };
    },
  ): Promise<"created" | "updated" | "skipped"> {
    const existing = await this.db.query.supportKnowledgeGaps.findFirst({
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
      )
        return "skipped";
      await this.db
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

    await this.db.insert(supportKnowledgeGaps).values({
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
}
