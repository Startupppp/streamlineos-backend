import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  vendorPayments,
  finVendorPaymentAllocations,
  purchaseBills,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
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
      .where(eq(finVendorPaymentAllocations.vendorPaymentId, input.vendorPaymentId));

    const alreadyAllocated = Number(existingAllocations[0]?.total ?? 0);
    const paymentAmount = Number(payment.amount);
    const requestedTotal = round2(input.allocations.reduce((acc, a) => acc + a.amount, 0));

    if (alreadyAllocated + requestedTotal > paymentAmount + 0.005) {
      throw new BadRequestException(
        `Total allocation ${(alreadyAllocated + requestedTotal).toFixed(2)} exceeds payment amount ${paymentAmount.toFixed(2)}`,
      );
    }

    for (const alloc of input.allocations) {
      const billRows = await this.db
        .select()
        .from(purchaseBills)
        .where(and(eq(purchaseBills.id, alloc.billId), eq(purchaseBills.orgId, orgId)))
        .limit(1);
      const bill = billRows[0];
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

    await this.db.transaction(async (tx) => {
      for (const alloc of input.allocations) {
        await tx
          .insert(finVendorPaymentAllocations)
          .values({
            orgId,
            vendorPaymentId: input.vendorPaymentId,
            billId: alloc.billId,
            amount: alloc.amount.toFixed(4),
          })
          .onConflictDoUpdate({
            target: [finVendorPaymentAllocations.vendorPaymentId, finVendorPaymentAllocations.billId],
            set: { amount: alloc.amount.toFixed(4) },
          });

        const billCurrent = await tx
          .select({ amountPaid: purchaseBills.amountPaid, total: purchaseBills.total })
          .from(purchaseBills)
          .where(and(eq(purchaseBills.id, alloc.billId), eq(purchaseBills.orgId, orgId)))
          .limit(1);

        const bc = billCurrent[0];
        if (bc) {
          const newPaid = round2(Number(bc.amountPaid ?? 0) + alloc.amount);
          const total = Number(bc.total ?? 0);
          const newStatus = newPaid >= total - 0.005 ? "PAID" : "PARTIALLY_PAID";

          await tx
            .update(purchaseBills)
            .set({ amountPaid: newPaid.toFixed(4), status: newStatus, updatedAt: new Date() })
            .where(and(eq(purchaseBills.id, alloc.billId), eq(purchaseBills.orgId, orgId)));
        }
      }
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
