import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  vendorPayments,
  finVendorPaymentAllocations,
  purchaseBills,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import type { ManualAllocationInput } from "./dto/finance-ap.schemas";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class VendorPaymentsAllocationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async allocate(orgId: string, userId: string, input: ManualAllocationInput) {
    const paymentRows = await this.db
      .select()
      .from(vendorPayments)
      .where(and(eq(vendorPayments.id, input.vendorPaymentId), eq(vendorPayments.orgId, orgId)))
      .limit(1);
    const payment = paymentRows[0];
    if (!payment) throw new NotFoundException("Vendor payment not found");

    const existingAllocations = await this.db
      .select({ total: sql<string>`COALESCE(sum(${finVendorPaymentAllocations.amount}::numeric), 0)::text` })
      .from(finVendorPaymentAllocations)
      .where(and(eq(finVendorPaymentAllocations.vendorPaymentId, input.vendorPaymentId), eq(finVendorPaymentAllocations.orgId, orgId)));

    const alreadyAllocated = Number(existingAllocations[0]?.total ?? 0);
    const paymentAmount = Number(payment.amount);
    const requestedTotal = round2(input.allocations.reduce((acc, a) => acc + a.amount, 0));

    if (alreadyAllocated + requestedTotal > paymentAmount + 0.005) {
      throw new BadRequestException(
        `Total allocation ${(alreadyAllocated + requestedTotal).toFixed(2)} exceeds payment amount ${paymentAmount.toFixed(2)}`,
      );
    }

    /*
     * Collapsed by bill before anything is validated or written. A request naming
     * the same bill twice used to upsert the allocation row twice — the last
     * amount won — while incrementing the bill's paid total by both, so the
     * allocation and the bill disagreed. It also made the set-based upsert below
     * illegal (`ON CONFLICT DO UPDATE cannot affect row a second time`). One
     * entry per bill carrying the request's total for it is the consistent
     * reading of the same intent.
     */
    const amountByBill = new Map<number, number>();
    for (const alloc of input.allocations)
      amountByBill.set(alloc.billId, round2((amountByBill.get(alloc.billId) ?? 0) + alloc.amount));
    const allocations = [...amountByBill].map(([billId, amount]) => ({ billId, amount }));

    const billIds = allocations.map((a) => a.billId);
    const billRows = billIds.length > 0
      ? await this.db
          .select()
          .from(purchaseBills)
          .where(and(inArray(purchaseBills.id, billIds), eq(purchaseBills.orgId, orgId)))
          .limit(billIds.length)
      : [];
    const billMap = new Map(billRows.map((b) => [b.id, b]));

    for (const alloc of allocations) {
      const bill = billMap.get(alloc.billId);
      if (!bill) throw new NotFoundException(`Purchase bill ${alloc.billId} not found`);
      if (bill.status === "CANCELLED") {
        throw new ConflictException(`Bill ${alloc.billId} is cancelled`);
      }

      const outstanding = round2(Number(bill.total ?? 0) - Number(bill.amountPaid ?? 0));
      if (alloc.amount > outstanding + 0.005) {
        throw new BadRequestException(
          `Allocation amount ${alloc.amount.toFixed(2)} exceeds bill ${alloc.billId} outstanding ${outstanding.toFixed(2)}`,
        );
      }
    }

    /*
     * Two statements for the whole request instead of three per allocation, and
     * the bill balance moves with atomic SQL.
     *
     * The previous shape read `amount_paid`, added the allocation in JavaScript
     * and wrote the sum back. Two allocations settling against the same bill at
     * the same time both read the same balance and the second write erased the
     * first — money silently unapplied. `amount_paid + v.amount` is evaluated by
     * the database against the row it is already locking, so there is no window.
     */
    await this.db.transaction(async (tx) => {
      if (allocations.length === 0) return;

      await tx
        .insert(finVendorPaymentAllocations)
        .values(
          allocations.map((alloc) => ({
            orgId,
            vendorPaymentId: input.vendorPaymentId,
            billId: alloc.billId,
            amount: alloc.amount.toFixed(4),
          })),
        )
        .onConflictDoUpdate({
          target: [finVendorPaymentAllocations.vendorPaymentId, finVendorPaymentAllocations.billId],
          set: { amount: sql`excluded.amount` },
        });

      const applied = sql.join(
        allocations.map(
          (alloc) => sql`(${alloc.billId}::integer, ${alloc.amount.toFixed(4)}::numeric)`,
        ),
        sql`, `,
      );

      await tx.execute(sql`
        UPDATE ${purchaseBills} AS b
        SET amount_paid = round(b.amount_paid + v.amount, 4),
            status = CASE
              WHEN b.amount_paid + v.amount >= b.total - 0.005 THEN 'PAID'
              ELSE 'PARTIALLY_PAID'
            END,
            updated_at = now()
        FROM (VALUES ${applied}) AS v(bill_id, amount)
        WHERE b.id = v.bill_id AND b.org_id = ${orgId}
      `);
    });

    this.audit.log({
      action: "accounting.vendor_payment.allocate",
      userId,
      orgId,
      resourceType: "vendor_payment",
      resourceId: String(input.vendorPaymentId),
      metadata: { allocations: input.allocations },
      result: "SUCCESS",
    });

    return { vendorPaymentId: input.vendorPaymentId, allocated: input.allocations.length };
  }
}
