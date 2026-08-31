import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  vendorCredits,
  vendorCreditItems,
  purchaseBills,
  clients,
  accNumberSequences,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import { JournalPostingService } from "../../accounting/posting/journal-posting.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import type {
  CreateVendorCreditInput,
  ApplyVendorCreditInput,
  ListVendorCreditsQuery,
} from "./dto/finance-ap.schemas";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const VC_CACHE_KEY = (orgId: string) => `fin:vendor-credits:list:${orgId}`;

@Injectable()
export class VendorCreditsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly financePosting: FinancePostingService,
    private readonly journalPosting: JournalPostingService,
  ) {}

  async listVendorCredits(orgId: string, query: ListVendorCreditsQuery) {
    const { page, pageSize, vendorId, status } = query;
    const conds = [eq(vendorCredits.orgId, orgId)];
    if (vendorId) conds.push(eq(vendorCredits.vendorId, vendorId));
    if (status) conds.push(eq(vendorCredits.status, status));

    const where = and(...conds);
    const { offset, limit } = paginateOffset({ page, pageSize });

    const rows = await this.db
      .select({
        id: vendorCredits.id,
        vendorCreditNumber: vendorCredits.vendorCreditNumber,
        vendorId: vendorCredits.vendorId,
        vendorName: clients.name,
        billId: vendorCredits.billId,
        status: vendorCredits.status,
        reason: vendorCredits.reason,
        subtotal: vendorCredits.subtotal,
        taxAmount: vendorCredits.taxAmount,
        total: vendorCredits.total,
        appliedAmount: vendorCredits.appliedAmount,
        currency: vendorCredits.currency,
        createdAt: vendorCredits.createdAt,
        _rowCount: sql<number>`count(*) OVER ()`,
      })
      .from(vendorCredits)
      .leftJoin(clients, eq(clients.id, vendorCredits.vendorId))
      .where(where)
      .orderBy(desc(vendorCredits.createdAt))
      .offset(offset)
      .limit(limit);

    const pageTotal = Number(rows[0]?._rowCount ?? 0);
    const items = rows.map(({ _rowCount: _rc, ...item }) => item);
    return buildListResponse(items, pageTotal, { page, pageSize });
  }

  async getVendorCredit(orgId: string, vendorCreditId: number) {
    const rows = await this.db
      .select({
        id: vendorCredits.id,
        vendorCreditNumber: vendorCredits.vendorCreditNumber,
        vendorId: vendorCredits.vendorId,
        vendorName: clients.name,
        billId: vendorCredits.billId,
        status: vendorCredits.status,
        reason: vendorCredits.reason,
        subtotal: vendorCredits.subtotal,
        taxAmount: vendorCredits.taxAmount,
        total: vendorCredits.total,
        appliedAmount: vendorCredits.appliedAmount,
        currency: vendorCredits.currency,
        notes: vendorCredits.notes,
        createdAt: vendorCredits.createdAt,
        updatedAt: vendorCredits.updatedAt,
      })
      .from(vendorCredits)
      .leftJoin(clients, eq(clients.id, vendorCredits.vendorId))
      .where(and(eq(vendorCredits.id, vendorCreditId), eq(vendorCredits.orgId, orgId)))
      .limit(1);

    const header = rows[0];
    if (!header) throw new NotFoundException("Vendor credit not found");

    const items = await this.db
      .select()
      .from(vendorCreditItems)
      .where(eq(vendorCreditItems.vendorCreditId, vendorCreditId));

    return { ...header, items };
  }

  private async nextVendorCreditNumber(orgId: string): Promise<string> {
    const inserted = await this.db
      .insert(accNumberSequences)
      .values({ orgId, entityType: "vendor_credit", prefix: "VC", nextNumber: 2, padding: 4 })
      .onConflictDoUpdate({
        target: [accNumberSequences.orgId, accNumberSequences.entityType],
        set: { nextNumber: sql`${accNumberSequences.nextNumber} + 1` },
      })
      .returning({ next: accNumberSequences.nextNumber, padding: accNumberSequences.padding });

    const row = inserted[0];
    if (!row) throw new Error("Sequence upsert returned no rows");
    const seq = row.next - 1;
    const pad = row.padding ?? 4;
    return `VC-${String(seq).padStart(pad, "0")}`;
  }

  async createVendorCredit(orgId: string, userId: string, input: CreateVendorCreditInput) {
    const itemsWithAmounts = input.items.map((it, idx) => {
      const amount = round2(it.quantity * it.rate);
      const tax = round2(amount * (it.gstRate / 100));
      return { ...it, amount, tax, lineOrder: idx };
    });

    const subtotal = round2(itemsWithAmounts.reduce((acc, it) => acc + it.amount, 0));
    const taxTotal = round2(itemsWithAmounts.reduce((acc, it) => acc + it.tax, 0));
    const total = round2(subtotal + taxTotal);

    const vendorCreditNumber = await this.nextVendorCreditNumber(orgId);

    const inserted = await this.db.transaction(async (tx) => {
      const [vc] = await tx
        .insert(vendorCredits)
        .values({
          orgId,
          vendorCreditNumber,
          vendorId: input.vendorId,
          billId: input.billId ?? null,
          reason: input.reason ?? null,
          notes: input.notes ?? null,
          currency: input.currency,
          subtotal: subtotal.toFixed(4),
          taxAmount: taxTotal.toFixed(4),
          total: total.toFixed(4),
          appliedAmount: "0",
          status: "DRAFT",
          createdBy: userId,
        })
        .returning();

      if (!vc) throw new Error("Vendor credit insert returned no rows");

      if (itemsWithAmounts.length > 0) {
        await tx.insert(vendorCreditItems).values(
          itemsWithAmounts.map((it) => ({
            orgId,
            vendorCreditId: vc.id,
            description: it.description,
            hsnSacCode: it.hsnSacCode ?? null,
            quantity: it.quantity.toFixed(4),
            rate: it.rate.toFixed(4),
            gstRate: it.gstRate.toFixed(2),
            amount: it.amount.toFixed(4),
            lineOrder: it.lineOrder,
          })),
        );
      }

      return vc;
    });

    await this.cache.invalidate(VC_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.vendor_credit.create",
      userId,
      orgId,
      resourceType: "vendor_credit",
      resourceId: String(inserted.id),
      result: "SUCCESS",
    });

    return inserted;
  }

  async postVendorCredit(u: CurrentUserContext, vendorCreditId: number) {
    const { orgId, userId } = u;

    const rows = await this.db
      .select()
      .from(vendorCredits)
      .where(and(eq(vendorCredits.id, vendorCreditId), eq(vendorCredits.orgId, orgId)))
      .limit(1);
    const vc = rows[0];
    if (!vc) throw new NotFoundException("Vendor credit not found");
    if (vc.status !== "DRAFT") {
      throw new ConflictException(`Vendor credit is in status ${vc.status}; only DRAFT can be posted`);
    }

    await this.journalPosting.seedChartOfAccountsForOrg(orgId);

    const total = Number(vc.total ?? 0);
    const taxAmount = Number(vc.taxAmount ?? 0);
    const subtotal = Number(vc.subtotal ?? 0);
    const today = new Date().toISOString().slice(0, 10);

    await this.financePosting.postJournal(u, {
      entryDate: today,
      description: `Vendor credit ${vc.vendorCreditNumber} posted`,
      sourceType: "vendor_credit",
      sourceId: String(vendorCreditId),
      sourceEvent: "post",
      lines: [
        { systemPurpose: "AP", debit: String(total), credit: "0" },
        { systemPurpose: "EXPENSE_CLEARING", debit: "0", credit: String(subtotal) },
        ...(taxAmount > 0
          ? [{ systemPurpose: "TAX_RECEIVABLE" as const, debit: "0", credit: String(taxAmount) }]
          : []),
      ],
    });

    await this.db
      .update(vendorCredits)
      .set({ status: "POSTED", updatedAt: new Date() })
      .where(and(eq(vendorCredits.id, vendorCreditId), eq(vendorCredits.orgId, orgId)));

    await this.cache.invalidate(VC_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.vendor_credit.post",
      userId,
      orgId,
      resourceType: "vendor_credit",
      resourceId: String(vendorCreditId),
      result: "SUCCESS",
    });

    return { id: vendorCreditId, status: "POSTED" };
  }

  async applyVendorCredit(u: CurrentUserContext, vendorCreditId: number, input: ApplyVendorCreditInput) {
    const { orgId, userId } = u;

    const vcRows = await this.db
      .select()
      .from(vendorCredits)
      .where(and(eq(vendorCredits.id, vendorCreditId), eq(vendorCredits.orgId, orgId)))
      .limit(1);
    const vc = vcRows[0];
    if (!vc) throw new NotFoundException("Vendor credit not found");
    if (vc.status !== "POSTED") {
      throw new ConflictException("Only POSTED vendor credits can be applied");
    }

    const vcTotal = Number(vc.total ?? 0);
    const alreadyApplied = Number(vc.appliedAmount ?? 0);
    const remaining = round2(vcTotal - alreadyApplied);
    if (input.amount > remaining + 0.005) {
      throw new BadRequestException(
        `Amount ${input.amount.toFixed(2)} exceeds remaining credit ${remaining.toFixed(2)}`,
      );
    }

    const billRows = await this.db
      .select()
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, input.billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    const bill = billRows[0];
    if (!bill) throw new NotFoundException("Purchase bill not found");
    if (bill.status === "CANCELLED") {
      throw new ConflictException("Cannot apply credit to a cancelled bill");
    }

    const billTotal = Number(bill.total ?? 0);
    const billPaid = Number(bill.amountPaid ?? 0);
    const billRemaining = round2(billTotal - billPaid);
    if (input.amount > billRemaining + 0.005) {
      throw new BadRequestException(
        `Amount ${input.amount.toFixed(2)} exceeds bill outstanding ${billRemaining.toFixed(2)}`,
      );
    }

    await this.db.transaction(async (tx) => {
      const newApplied = round2(alreadyApplied + input.amount);
      const newVcStatus = newApplied >= vcTotal - 0.005 ? "APPLIED" : "POSTED";

      await tx
        .update(vendorCredits)
        .set({
          appliedAmount: newApplied.toFixed(4),
          status: newVcStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(vendorCredits.id, vendorCreditId), eq(vendorCredits.orgId, orgId)));

      const newBillPaid = round2(billPaid + input.amount);
      const newBillStatus = newBillPaid >= billTotal - 0.005 ? "PAID" : "PARTIALLY_PAID";

      await tx
        .update(purchaseBills)
        .set({
          amountPaid: newBillPaid.toFixed(4),
          status: newBillStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(purchaseBills.id, input.billId), eq(purchaseBills.orgId, orgId)));
    });

    await this.cache.invalidate(VC_CACHE_KEY(orgId));

    this.audit.log({
      action: "accounting.vendor_credit.apply",
      userId,
      orgId,
      resourceType: "vendor_credit",
      resourceId: String(vendorCreditId),
      metadata: { billId: input.billId, amount: input.amount },
      result: "SUCCESS",
    });

    return { id: vendorCreditId, billId: input.billId, appliedAmount: input.amount };
  }
}
