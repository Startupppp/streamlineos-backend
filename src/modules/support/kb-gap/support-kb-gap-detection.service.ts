import { Inject, Injectable } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { logger } from "../../../common/logger/logger.service";
import {
  clusterTicketEmbeddings,
  getSearchGaps,
  upsertGaps,
  type GapUpsertEntry,
} from "./lib/gap-detection";

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

    /*
     * Both sources are projected into one list and written in one pass.
     *
     * These were two loops, each awaiting `upsertGap` per row, and `upsertGap`
     * is itself read-then-write — so a pass cost `2 x (clusters + searchGaps)`
     * round trips, serialised on the connection the cron sweep holds. The
     * search half is bounded at 20 by `getSearchGaps`; the cluster half is NOT
     * bounded by anything (see the note on `runDetectAllOrgs` below), which is
     * what made this a real N+1 rather than a small fixed cost.
     *
     * The `.map`s below open no database call — the only statements are inside
     * `upsertGaps`, which chunks them.
     */
    const entries: GapUpsertEntry[] = [
      ...ticketClusters.map((cluster) => ({
        clusterKey: `cluster:${cluster.representativeTicketId}`,
        representativeQuestion: cluster.representativeQuestion,
        ticketCount: cluster.ticketIds.length,
        sampleTicketIds: cluster.ticketIds.slice(0, 10),
        evidence: { searchQueries: [], relatedTicketIds: cluster.ticketIds },
      })),
      ...searchGaps
        .filter((gap): gap is typeof gap & { query: string } => Boolean(gap.query))
        .map((gap) => ({
          clusterKey: `search:${gap.query}`,
          representativeQuestion: gap.query,
          ticketCount: gap.count,
          sampleTicketIds: [],
          evidence: {
            searchQueries: [{ query: gap.query, count: gap.count }],
            relatedTicketIds: [],
          },
        })),
    ];

    const { created, updated } = await upsertGaps(this.db, orgId, entries);
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
