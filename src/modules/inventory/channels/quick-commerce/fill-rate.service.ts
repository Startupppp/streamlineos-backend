import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invPlatformPayoutLines,
  invPlatformPoLines,
  invPlatformPurchaseOrders,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { FillRateQuery, UploadPayoutInput } from "./dto/quick-commerce.schemas";
import {
  percentage,
  report,
  type FillRateLine,
  type FillRateReport,
  type FillRateReportDeps,
  type UnmatchedPayoutLine,
} from "./lib/fill-rate-report";

/**
 * The read half — the report, its four readers and the exact percentage — is
 * in `lib/fill-rate-report.ts`. Re-exported so `__tests__/fill-rate.spec.ts`
 * and anything else importing from this file keep resolving.
 */
export { percentage };
export type { FillRateLine, FillRateReport, UnmatchedPayoutLine };

/**
 * NEO-3 - did we ship what the platform ordered, and did they pay for it.
 *
 * Three numbers a quick-commerce seller is judged on, and Streamline could
 * answer none of them: ordered, accepted, settled. Fill rate is the platform's
 * own scorecard - miss it and the listing is throttled - so a seller who cannot
 * see it before the platform tells them is finding out too late.
 *
 * **This writes nothing to the general ledger, and it is not a bank
 * reconciliation.** It compares three documents we already hold: what the
 * platform ordered, what our own sales orders shipped against it, and what the
 * platform's uploaded payout file says. Where they disagree it says so and names
 * the line. Turning that into a journal entry is accounting's work and would
 * need a real settlement account, which this has no business inventing.
 */
@Injectable()
export class FillRateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  private get reportDeps(): FillRateReportDeps {
    return { db: this.db, warehouseScope: this.warehouseScope };
  }

  report(orgId: string, userId: string, query: FillRateQuery): Promise<FillRateReport> {
    return report(this.reportDeps, orgId, userId, query);
  }

  /**
   * Take a platform payout file.
   *
   * Uploaded, not fetched: there is no connected account, and pretending
   * otherwise is the failure this programme keeps being burnt by. Every row is
   * matched against a platform PO line by (provider PO number, SKU or EAN), and
   * the ones that do not match are stored **unmatched, with the reason** - they
   * are the output somebody has to act on, and a matcher that silently dropped
   * what it could not place would hide exactly those lines.
   *
   * Re-uploading the same file is a no-op: `uniq_inv_platform_payout_line_key`
   * is the fence, and a settlement counted twice is worse than one counted late.
   */
  async uploadPayout(orgId: string, userId: string, input: UploadPayoutInput) {
    if (input.lines.length === 0) throw new BadRequestException("The payout file has no lines");

    const poNumbers = [
      ...new Set(input.lines.map((l) => l.providerPoNumber).filter((v): v is string => Boolean(v))),
    ];
    const candidates =
      poNumbers.length === 0
        ? []
        : await this.db
            .select({
              lineId: invPlatformPoLines.id,
              providerSku: invPlatformPoLines.providerSku,
              ean: invPlatformPoLines.ean,
              providerPoNumber: invPlatformPurchaseOrders.providerPoNumber,
            })
            .from(invPlatformPoLines)
            .innerJoin(
              invPlatformPurchaseOrders,
              and(
                eq(invPlatformPurchaseOrders.orgId, invPlatformPoLines.orgId),
                eq(invPlatformPurchaseOrders.id, invPlatformPoLines.platformPoId),
              ),
            )
            .where(
              and(
                eq(invPlatformPoLines.orgId, orgId),
                sql`${invPlatformPurchaseOrders.provider} = ${input.provider}`,
                inArray(invPlatformPurchaseOrders.providerPoNumber, poNumbers),
              ),
            );

    const bySku = new Map<string, number>();
    const byEan = new Map<string, number>();
    for (const row of candidates) {
      if (row.providerSku) bySku.set(`${row.providerPoNumber}::${row.providerSku}`, row.lineId);
      if (row.ean) byEan.set(`${row.providerPoNumber}::${row.ean}`, row.lineId);
    }

    const values = input.lines.map((line) => {
      const poNumber = line.providerPoNumber ?? "";
      const matched =
        (line.providerSku ? bySku.get(`${poNumber}::${line.providerSku}`) : undefined) ??
        (line.ean ? byEan.get(`${poNumber}::${line.ean}`) : undefined) ??
        null;

      return {
        orgId,
        provider: input.provider,
        payoutRef: input.payoutRef,
        providerPoNumber: line.providerPoNumber ?? null,
        providerSku: line.providerSku ?? null,
        ean: line.ean ?? null,
        quantity: line.quantity,
        amountPaise: line.amountPaise,
        settledOn: input.settledOn ?? null,
        platformPoLineId: matched,
        unmatchedReason:
          matched !== null
            ? null
            : !line.providerPoNumber
              ? "The payout line names no purchase order"
              : `No line on ${line.providerPoNumber} carries ${line.providerSku ?? line.ean ?? "this item"}`,
        createdBy: userId,
      };
    });

    const inserted = await this.db
      .insert(invPlatformPayoutLines)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: invPlatformPayoutLines.id, platformPoLineId: invPlatformPayoutLines.platformPoLineId });

    const unmatched = inserted.filter((r) => r.platformPoLineId === null).length;

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "platform_payout.upload",
      resourceType: "inv_platform_payout",
      resourceId: input.payoutRef,
      after: { provider: input.provider, lines: inserted.length, unmatched },
      metadata: { submitted: input.lines.length, duplicatesIgnored: input.lines.length - inserted.length },
    });

    return {
      payoutRef: input.payoutRef,
      submitted: input.lines.length,
      stored: inserted.length,
      duplicatesIgnored: input.lines.length - inserted.length,
      unmatched,
    };
  }
}
