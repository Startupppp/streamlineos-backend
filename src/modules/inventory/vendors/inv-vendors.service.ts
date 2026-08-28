import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  invVendors, invPurchaseOrders, invGrns, invGrnLines, invPoLines, invVendorReturns, invVendorReturnLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type { ListVendorsInput, CreateVendorInput, UpdateVendorInput } from "./dto/inv-vendors.schemas";
import { LeadTimeService } from "../replenishment/forecast/lead-time.service";

@Injectable()
export class InvVendorsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly leadTime: LeadTimeService,
  ) {}

  async listVendors(orgId: string, filters: ListVendorsInput) {
    const { search, isActive, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${search ?? ""}:${isActive ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invVendorsNamespace(orgId), hash, async () => {
      const conditions = [eq(invVendors.orgId, orgId)];
      if (search) conditions.push(ilike(invVendors.name, `%${search}%`));
      if (isActive !== undefined) conditions.push(eq(invVendors.isActive, isActive));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invVendors.findMany({
          where,
          orderBy: [desc(invVendors.name)],
          limit,
          offset,
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invVendors).where(where),
      ]);

      return {
        items,
        total: countResult[0]?.count ?? 0,
        page,
        totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
      };
    }, CACHE_TTL.SHORT);
  }

  async getVendor(orgId: string, vendorId: number) {
    const vendor = await this.db.query.invVendors.findFirst({
      where: and(eq(invVendors.id, vendorId), eq(invVendors.orgId, orgId)),
    });
    if (!vendor) throw new NotFoundException("Vendor not found");
    return vendor;
  }

  private async nextVendorCode(orgId: string): Promise<string> {
    const rows = await this.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(invVendors)
      .where(eq(invVendors.orgId, orgId));
    const cnt = rows[0]?.cnt ?? 0;
    return `VND-${String(cnt + 1).padStart(4, "0")}`;
  }

  async createVendor(orgId: string, userId: string, data: CreateVendorInput) {
    const code = data.code ?? (await this.nextVendorCode(orgId));
    const existing = await this.db.query.invVendors.findFirst({
      where: and(eq(invVendors.orgId, orgId), eq(invVendors.code, code)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A vendor with this code already exists");

    const [vendor] = await this.db.insert(invVendors).values({ orgId, createdBy: userId, ...data, code }).returning();
    await this.cache.invalidateNamespace(CACHE_KEYS.invVendorsNamespace(orgId));
    return vendor;
  }

  async updateVendor(orgId: string, vendorId: number, data: UpdateVendorInput) {
    if (data.isActive === false) {
      const [openRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invPurchaseOrders)
        .where(and(
          eq(invPurchaseOrders.orgId, orgId),
          eq(invPurchaseOrders.vendorId, vendorId),
          inArray(invPurchaseOrders.status, ["DRAFT", "SENT", "PARTIAL"])
        ));
      if ((openRow?.count ?? 0) > 0) {
        throw new ConflictException("Cannot deactivate vendor with open purchase orders");
      }
    }

    const [updated] = await this.db.update(invVendors)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invVendors.id, vendorId), eq(invVendors.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Vendor not found");
    await this.cache.invalidateNamespace(CACHE_KEYS.invVendorsNamespace(orgId));
    return updated;
  }

  /**
   * INV-307 — the supplier scorecard.
   *
   * Extended rather than replaced, so there is one answer to "how is this
   * vendor doing" rather than two that disagree. What INV-307 adds is the
   * quality and discrepancy record from receiving, and lead-time percentiles
   * from the measured estimator rather than a second copy of the arithmetic.
   *
   * No composite grade. A single letter hides which of five things went wrong,
   * and the whole point of a scorecard is deciding what to say to the supplier.
   * Every rate is reported beside the count it was computed from, because a
   * 50% rejection rate over two receipts is not a quality problem, it is two
   * receipts.
   */
  async getVendorPerformance(orgId: string, vendorId: number) {
    const vendor = await this.db.query.invVendors.findFirst({
      where: and(eq(invVendors.id, vendorId), eq(invVendors.orgId, orgId)),
      columns: { id: true },
    });
    if (!vendor) throw new NotFoundException("Vendor not found");

    const [openCountRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invPurchaseOrders)
      .where(and(
        eq(invPurchaseOrders.orgId, orgId),
        eq(invPurchaseOrders.vendorId, vendorId),
        inArray(invPurchaseOrders.status, ["DRAFT", "SENT", "PARTIAL"])
      ));
    const openPoCount = openCountRow?.count ?? 0;

    const [spendRow] = await this.db
      .select({ total: sql<string>`coalesce(sum(${invPurchaseOrders.total}), '0')` })
      .from(invPurchaseOrders)
      .where(and(
        eq(invPurchaseOrders.orgId, orgId),
        eq(invPurchaseOrders.vendorId, vendorId),
        inArray(invPurchaseOrders.status, ["RECEIVED", "CLOSED"])
      ));
    const totalSpend = spendRow?.total ?? "0";

    const [fillRow] = await this.db
      .select({
        totalOrdered: sql<string>`coalesce(sum(${invPoLines.quantity}), '0')`,
        totalReceived: sql<string>`coalesce(sum(${invPoLines.quantityReceived}), '0')`,
      })
      .from(invPoLines)
      .innerJoin(invPurchaseOrders, and(
        eq(invPoLines.poId, invPurchaseOrders.id),
        eq(invPurchaseOrders.orgId, orgId),
        eq(invPurchaseOrders.vendorId, vendorId),
        inArray(invPurchaseOrders.status, ["RECEIVED", "CLOSED"])
      ));
    const totalOrdered = parseFloat(fillRow?.totalOrdered ?? "0");
    const totalReceived = parseFloat(fillRow?.totalReceived ?? "0");
    const fillRate = totalOrdered === 0 ? 0 : totalReceived / totalOrdered;

    const closedPOs = await this.db
      .select({
        id: invPurchaseOrders.id,
        sentAt: invPurchaseOrders.sentAt,
        expectedDeliveryDate: invPurchaseOrders.expectedDeliveryDate,
      })
      .from(invPurchaseOrders)
      .where(and(
        eq(invPurchaseOrders.orgId, orgId),
        eq(invPurchaseOrders.vendorId, vendorId),
        inArray(invPurchaseOrders.status, ["RECEIVED", "CLOSED"])
      ));

    let onTimeCount = 0;
    let poWithExpAndGrn = 0;
    let totalLeadDays = 0;
    let posWithLead = 0;

    if (closedPOs.length > 0) {
      const poIds = closedPOs.map(p => p.id);
      const firstGrns = await this.db
        .select({
          poId: invGrns.poId,
          receivedDate: sql<string>`min(${invGrns.receivedDate})`,
        })
        .from(invGrns)
        .where(inArray(invGrns.poId, poIds))
        .groupBy(invGrns.poId);

      const grnMap = new Map(firstGrns.map(g => [g.poId, g.receivedDate]));

      for (const po of closedPOs) {
        const firstGrnDate = grnMap.get(po.id);
        if (po.expectedDeliveryDate && firstGrnDate) {
          poWithExpAndGrn++;
          if (firstGrnDate <= po.expectedDeliveryDate) onTimeCount++;
        }
        if (po.sentAt && firstGrnDate) {
          const daysDiff = (new Date(firstGrnDate).getTime() - po.sentAt.getTime()) / 86400000;
          totalLeadDays += daysDiff;
          posWithLead++;
        }
      }
    }

    const onTimeRate = poWithExpAndGrn === 0 ? 0 : onTimeCount / poWithExpAndGrn;
    const avgLeadTimeDays = posWithLead === 0 ? 0 : totalLeadDays / posWithLead;

    const [returnQtyRow] = await this.db
      .select({ total: sql<string>`coalesce(sum(${invVendorReturnLines.quantity}), '0')` })
      .from(invVendorReturnLines)
      .innerJoin(invVendorReturns, and(
        eq(invVendorReturnLines.returnId, invVendorReturns.id),
        eq(invVendorReturns.orgId, orgId),
        eq(invVendorReturns.vendorId, vendorId)
      ));
    const returnQty = parseFloat(returnQtyRow?.total ?? "0");

    const [receivedQtyRow] = await this.db
      .select({ total: sql<string>`coalesce(sum(${invGrnLines.quantityReceived}), '0')` })
      .from(invGrnLines)
      .innerJoin(invGrns, eq(invGrnLines.grnId, invGrns.id))
      .innerJoin(invPurchaseOrders, and(
        eq(invGrns.poId, invPurchaseOrders.id),
        eq(invPurchaseOrders.orgId, orgId),
        eq(invPurchaseOrders.vendorId, vendorId),
        inArray(invPurchaseOrders.status, ["RECEIVED", "CLOSED"])
      ));
    const receivedQty = parseFloat(receivedQtyRow?.total ?? "0");
    const returnRate = receivedQty === 0 ? 0 : returnQty / receivedQty;

    // INV-307. Receiving quality: what arrived and was refused, and what
    // arrived and did not match the order. Both come from GRN lines, and both
    // were previously invisible in the scorecard even though receiving has
    // recorded them since INV-201.
    const [qualityRow] = await this.db.execute<{
      lines: number;
      rejected: number;
      discrepant: number;
    }>(sql`
      SELECT COUNT(gl.id)::int AS lines,
             COUNT(gl.id) FILTER (WHERE gl.quality_status = 'REJECTED')::int AS rejected,
             COUNT(gl.id) FILTER (WHERE gl.discrepancy_reason IS NOT NULL)::int AS discrepant
      FROM inv_grn_lines gl
      JOIN inv_grns g ON g.org_id = gl.org_id AND g.id = gl.grn_id
      JOIN inv_purchase_orders po ON po.org_id = g.org_id AND po.id = g.po_id
      WHERE gl.org_id = ${orgId} AND po.vendor_id = ${vendorId}
    `);

    const receivedLines = qualityRow?.lines ?? 0;
    const rejectedLines = qualityRow?.rejected ?? 0;
    const discrepantLines = qualityRow?.discrepant ?? 0;
    const rate = (numerator: number, denominator: number) =>
      denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));

    // Percentiles from the measured estimator rather than a second copy of the
    // arithmetic. The mean above is kept because callers already read it, but
    // p90 is the number to plan against -- a mean lead time is met about half
    // the time.
    const measuredLeadTime = await this.leadTime.vendorLeadTime(orgId, vendorId);

    return {
      vendorId,
      onTimeRate,
      fillRate,
      avgLeadTimeDays,
      returnRate,
      openPoCount,
      totalSpend,
      // INV-307 additions.
      receivedLines,
      rejectedLines,
      rejectionRate: rate(rejectedLines, receivedLines),
      discrepantLines,
      discrepancyRate: rate(discrepantLines, receivedLines),
      leadTimeP50Days: measuredLeadTime.p50Days,
      leadTimeP90Days: measuredLeadTime.p90Days,
      leadTimeObservations: measuredLeadTime.observations,
      /**
       * Deliberately no composite grade: a single letter hides which of five
       * things went wrong, and the point of a scorecard is deciding what to say
       * to the supplier. This is the honesty caveat instead.
       */
      sampleWarning:
        receivedLines === 0
          ? "This vendor has never delivered against a purchase order. Every rate here is zero because there is nothing to measure, not because the vendor is perfect."
          : receivedLines < 10
            ? `Rates are computed over ${receivedLines} received line(s) and describe those lines rather than a trend.`
            : undefined,
    };
  }
}
