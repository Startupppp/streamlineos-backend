import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { kbHealthItems } from "../../../db/schema/kb/health-items";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg, type ForEachOrgResult } from "../../../common/tenant";
import { type TenantTx } from "../../../db/drizzle.types";

const RULE_VERSION = 1;
const SCAN_BATCH = 50;

@Injectable()
export class KbContradictionScannerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async runContradictionScanForOrg(
    tx: TenantTx,
    orgId: string,
  ): Promise<number> {
    const now = new Date();

    const candidateRows = await tx.execute(sql`
      SELECT
        LEAST(p1.id, p2.id)::int AS page_a_id,
        GREATEST(p1.id, p2.id)::int AS page_b_id,
        p1.title AS shared_title
      FROM kb_pages p1
      JOIN kb_pages p2 ON
        p2.org_id = ${orgId}
        AND p2.space_id = p1.space_id
        AND p2.id > p1.id
        AND p2.deleted_at IS NULL
        AND p2.status = 'published'
        AND lower(p2.title) = lower(p1.title)
        AND md5(coalesce(p2.content_text, '')) IS DISTINCT FROM md5(coalesce(p1.content_text, ''))
      WHERE p1.org_id = ${orgId}
        AND p1.deleted_at IS NULL
        AND p1.status = 'published'
        AND p1.space_id IS NOT NULL
      ORDER BY p1.id
      LIMIT ${SCAN_BATCH}
    `);

    if (!candidateRows.length) return 0;

    const allPageIds = [
      ...new Set(
        candidateRows.flatMap((r) => [Number(r.page_a_id), Number(r.page_b_id)]),
      ),
    ];

    const existingItems = await tx
      .select({
        pageId: kbHealthItems.pageId,
        state: kbHealthItems.state,
        dismissalExpiresAt: kbHealthItems.dismissalExpiresAt,
      })
      .from(kbHealthItems)
      .where(
        and(
          eq(kbHealthItems.orgId, orgId),
          inArray(kbHealthItems.pageId, allPageIds),
          eq(kbHealthItems.kind, "contradictory_claim"),
          eq(kbHealthItems.ruleVersion, RULE_VERSION),
        ),
      );

    const activePageIds = new Set(
      existingItems
        .filter(
          (item) =>
            item.state === "open" ||
            (item.state === "dismissed" &&
              (item.dismissalExpiresAt === null ||
                item.dismissalExpiresAt > now)),
        )
        .map((item) => item.pageId),
    );

    type InsertRow = typeof kbHealthItems.$inferInsert;
    const toInsert: InsertRow[] = [];

    for (const row of candidateRows) {
      const pageAId = Number(row.page_a_id);
      const pageBId = Number(row.page_b_id);
      const sharedTitle = String(row.shared_title);
      if (!activePageIds.has(pageAId)) {
        toInsert.push({
          orgId,
          pageId: pageAId,
          kind: "contradictory_claim",
          ruleVersion: RULE_VERSION,
          state: "open",
          evidence: { conflictingPageId: pageBId, sharedTitle },
          detectedAt: now,
        });
      }
      if (!activePageIds.has(pageBId)) {
        toInsert.push({
          orgId,
          pageId: pageBId,
          kind: "contradictory_claim",
          ruleVersion: RULE_VERSION,
          state: "open",
          evidence: { conflictingPageId: pageAId, sharedTitle },
          detectedAt: now,
        });
      }
    }

    if (!toInsert.length) return 0;

    await tx.insert(kbHealthItems).values(toInsert);

    return toInsert.length;
  }

  async runContradictionScanAllOrgs(): Promise<ForEachOrgResult & { detected: number }> {
    let detected = 0;
    const result = await forEachOrg(
      this.db,
      "kb-contradiction-scan",
      async (tx, orgId) => {
        const count = await this.runContradictionScanForOrg(tx, orgId);
        detected += count;
      },
    );
    return { ...result, detected };
  }
}
