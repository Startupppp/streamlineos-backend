import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg, runWithTenantContext, withTenant, type TenantTx } from "../../../common/tenant";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";

/**
 * G3 — the one trigger nothing can raise for itself.
 *
 * Low stock, an adjustment awaiting approval and a recall are all consequences
 * of somebody doing something, so each is emitted by the command that did it. A
 * lot getting closer to its expiry date is the opposite: nothing happens, and
 * that is precisely the problem. It needs a sweep.
 *
 * **No ambient tenant context**, so it iterates with `forEachOrg` — a background
 * job has no request transaction and no GUC, and a cross-org discovery query
 * would be denied by RLS before it returned a row. One transaction per
 * organisation, one failing organisation isolated from the rest.
 *
 * **Windows, not a threshold.** 90 / 60 / 30 days, and a lot raises its event
 * once per window it crosses — the consumer's dedupe key carries the window, so
 * a lot goes quiet between crossings instead of notifying on every sweep. The
 * windows are deliberately the same three D2 uses as allocation constraints, so
 * "you were warned" and "the allocator started refusing it" line up rather than
 * being two independent opinions about the same lot.
 *
 * **Only lots that still have stock.** A lot at zero on-hand expiring tomorrow
 * is a bookkeeping fact, not a thing anyone can act on, and a warehouse that
 * receives twenty such notifications stops reading the category.
 */
export const NEAR_EXPIRY_WINDOWS_DAYS = [90, 60, 30] as const;

interface ExpiringLotRow extends Record<string, unknown> {
  id: number;
  lot_number: string;
  product_variant_id: number;
  expiry_date: string;
  window_days: number;
  on_hand: string;
}

@Injectable()
export class InvExpirySweepService {
  private readonly logger = new Logger(InvExpirySweepService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Raises `inventory.lot.expiring` for one organisation's lots.
   *
   * Split from `sweepAll` because the two have different authority. A tenant's
   * inventory administrator may sweep their own organisation; nobody holding a
   * tenant-scoped permission may drive work across every tenant on the platform.
   * The endpoint calls this one.
   */
  async sweepOrg(orgId: string): Promise<{ events: number }> {
    let events = 0;
    await withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, () =>
        this.sweepWithin(tx, orgId, () => {
          events += 1;
        }),
      ),
    );
    this.logger.log(`inventory expiry sweep for ${orgId}: ${events} lot(s)`);
    return { events };
  }

  /**
   * Every organisation, for the background scheduler.
   *
   * **Not reachable over HTTP.** It writes into every tenant, so exposing it
   * behind a tenant-scoped permission would let one organisation's administrator
   * drive work in organisations they have no relationship with — and the
   * `{ organizations }` count alone discloses the size of the platform.
   */
  async sweepAll(): Promise<{ organizations: number; events: number }> {
    let events = 0;

    const result = await forEachOrg(this.db, "inventory:expiry", async (tx, orgId) => {
      await this.sweepWithin(tx, orgId, () => {
        events += 1;
      });
    });

    this.logger.log(
      `inventory expiry sweep: ${events} lot(s) across ${result.succeeded}/${result.organizations} organisation(s), ${result.failed} failed`,
    );
    return { organizations: result.organizations, events };
  }

  /** The sweep itself, for one organisation, inside a tenant transaction. */
  private async sweepWithin(
    tx: TenantTx,
    orgId: string,
    onEvent: () => void,
  ): Promise<void> {
    {
      // The narrowest window a lot has entered — not every window it has passed.
      // A lot 20 days out has crossed 90, 60 and 30, and telling somebody about
      // all three at once is three notifications for one fact. `LEAST` picks the
      // most urgent, and the consumer's key carries it so the lot notifies again
      // only when it crosses into the next one.
      // One row per window, not one row of three columns. `VALUES (90, 60, 30)`
      // is a single row whose only named column is `w = 90`, so `MIN(w)` was
      // always 90 — every lot inside the widest window reported at 90 and never
      // escalated to 60 or 30, silently defeating the whole point of having
      // three of them. `VALUES (90),(60),(30)` is three rows.
      const windows = sql.join(
        NEAR_EXPIRY_WINDOWS_DAYS.map((d) => sql`(${d})`),
        sql`, `,
      );

      const rows = await tx.execute<ExpiringLotRow>(sql`
        WITH stocked AS (
          SELECT l.id,
                 l.lot_number,
                 l.product_variant_id,
                 l.expiry_date,
                 (l.expiry_date - CURRENT_DATE) AS days_left,
                 COALESCE(SUM(sl.on_hand), 0) AS on_hand
          FROM inv_lots l
          JOIN inv_stock_levels sl
            ON sl.org_id = l.org_id AND sl.lot_id = l.id
          WHERE l.org_id = ${orgId}
            AND l.status = 'ACTIVE'
            AND l.expiry_date IS NOT NULL
            AND l.expiry_date >= CURRENT_DATE
          GROUP BY l.id, l.lot_number, l.product_variant_id, l.expiry_date
          HAVING COALESCE(SUM(sl.on_hand), 0) > 0
        )
        SELECT id,
               lot_number,
               product_variant_id,
               expiry_date::text            AS expiry_date,
               (SELECT MIN(w) FROM (VALUES ${windows}) AS t(w) WHERE days_left <= w)::int AS window_days,
               on_hand::text                AS on_hand
        FROM stocked
        WHERE days_left <= ${Math.max(...NEAR_EXPIRY_WINDOWS_DAYS)}
        ORDER BY expiry_date ASC, id ASC
      `);

      for (const row of rows) {
        if (row.window_days === null || row.window_days === undefined) continue;
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "inv_lot",
          aggregateId: String(row.id),
          // The window, not a clock: two sweeps on the same day for the same lot
          // in the same window are the same fact, and the consumer's dedupe key
          // says so. A version that moved every run would defeat it.
          aggregateVersion: Number(row.window_days),
          eventType: "inventory.lot.expiring",
          payload: {
            lotId: Number(row.id),
            lotNumber: String(row.lot_number),
            productVariantId: Number(row.product_variant_id),
            expiryDate: String(row.expiry_date),
            windowDays: Number(row.window_days),
            onHand: String(row.on_hand),
          },
          occurredAt: new Date(),
        });
        onEvent();
      }
    }
  }
}
