import { Inject, Injectable } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { logger } from "../../../common/logger/logger.service";
import { clusterTicketEmbeddings, getSearchGaps, upsertGap } from "./lib/gap-detection";

/**
 * Knowledge-gap detection: clusters of similar open tickets and recurring
 * no-result searches become `support_knowledge_gaps` rows. The primitives
 * (clustering, search-gap query, upsert) are `lib/gap-detection.ts`; this
 * service is the orchestration and the all-orgs cron sweep.
 */
@Injectable()
export class SupportKbGapDetectionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async detectGaps(orgId: string): Promise<{ created: number; updated: number }> {
    const ticketClusters = await clusterTicketEmbeddings(this.db, orgId);
    const searchGaps = await getSearchGaps(this.db, orgId);

    let created = 0;
    let updated = 0;

    for (const cluster of ticketClusters) {
      const clusterKey = `cluster:${cluster.representativeTicketId}`;
      const result = await upsertGap(this.db, orgId, clusterKey, cluster.representativeQuestion, {
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
      const result = await upsertGap(this.db, orgId, clusterKey, gap.query, {
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
}
