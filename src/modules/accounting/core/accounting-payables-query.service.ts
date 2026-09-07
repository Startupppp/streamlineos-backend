import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import {
  clients,
  purchaseBills,
  purchaseBillItems,
  vendorPayments,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import type {
  AgedReceivablesQuery,
  ListVendorsQuery,
  ListPurchaseBillsQuery,
} from "./dto/accounting.schemas";
import { AccountingVendorQueryService } from "./accounting-vendor-query.service";

function escapeLike(value: string): string {
  return value.replaceAll("%", "\\%");
}

function afterCursor(sortLt: SQL, sortEq: SQL, idGt: SQL): SQL {
  const tie = and(sortEq, idGt);
  if (!tie) throw new Error("and() of two defined SQL conditions returned undefined");
  const combined = or(sortLt, tie);
  if (!combined) throw new Error("or() of two defined SQL conditions returned undefined");
  return combined;
}

const BILL_COLUMNS = {
  id: purchaseBills.id,
  orgId: purchaseBills.orgId,
  vendorId: purchaseBills.vendorId,
  vendorName: clients.name,
  billNumber: purchaseBills.billNumber,
  vendorBillNumber: purchaseBills.vendorBillNumber,
  billDate: purchaseBills.billDate,
  dueDate: purchaseBills.dueDate,
  status: purchaseBills.status,
  subtotal: purchaseBills.subtotal,
  taxAmount: purchaseBills.taxAmount,
  cgstAmount: purchaseBills.cgstAmount,
  sgstAmount: purchaseBills.sgstAmount,
  igstAmount: purchaseBills.igstAmount,
  discount: purchaseBills.discount,
  total: purchaseBills.total,
  amountPaid: purchaseBills.amountPaid,
  currency: purchaseBills.currency,
  placeOfSupply: purchaseBills.placeOfSupply,
  vendorGstin: purchaseBills.vendorGstin,
  supplierGstin: purchaseBills.supplierGstin,
  reverseCharge: purchaseBills.reverseCharge,
  notes: purchaseBills.notes,
  expenseAccountCode: purchaseBills.expenseAccountCode,
  createdBy: purchaseBills.createdBy,
  createdAt: purchaseBills.createdAt,
  updatedAt: purchaseBills.updatedAt,
};

@Injectable()
export class AccountingPayablesQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly vendorQuery: AccountingVendorQueryService,
  ) {}

  async listPurchaseBills(orgId: string, query: ListPurchaseBillsQuery, scope: DataScope, membershipId: number | null) {
    const { cursor, limit, q, status, vendorId } = query;
    const conds = [eq(purchaseBills.orgId, orgId)];
    if (status) {
      if (Array.isArray(status)) {
        conds.push(inArray(purchaseBills.status, status));
      } else {
        conds.push(eq(purchaseBills.status, status));
      }
    }
    if (vendorId) conds.push(eq(purchaseBills.vendorId, vendorId));
    if (q) conds.push(ilike(purchaseBills.billNumber, `%${escapeLike(q)}%`));
    conds.push(
      scope === "all"
        ? sql`true`
        : scope === "none" || membershipId === null
          ? sql`false`
          : applyScope(scope, orgId, String(membershipId), { ownerColumn: purchaseBills.createdByMembershipId }),
    );
    const pos = decodeCursor(cursor);
    if (pos) {
      const cursorId = Number(pos.id);
      conds.push(
        afterCursor(
          lt(purchaseBills.billDate, pos.sortValue),
          eq(purchaseBills.billDate, pos.sortValue),
          gt(purchaseBills.id, cursorId),
        ),
      );
    }
    const rows = await this.db
      .select(BILL_COLUMNS)
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(and(...conds))
      .orderBy(desc(purchaseBills.billDate), asc(purchaseBills.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.billDate,
      id: String(row.id),
    }));
  }

  async getPurchaseBill(orgId: string, billId: number) {
    const rows = await this.db
      .select(BILL_COLUMNS)
      .from(purchaseBills)
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    const header = rows[0];
    if (!header) throw new NotFoundException("Purchase bill not found");

    const items = await this.db
      .select({
        id: purchaseBillItems.id,
        billId: purchaseBillItems.billId,
        description: purchaseBillItems.description,
        hsnSacCode: purchaseBillItems.hsnSacCode,
        quantity: purchaseBillItems.quantity,
        rate: purchaseBillItems.rate,
        gstRate: purchaseBillItems.gstRate,
        amount: purchaseBillItems.amount,
        lineOrder: purchaseBillItems.lineOrder,
      })
      .from(purchaseBillItems)
      .where(eq(purchaseBillItems.billId, billId))
      .orderBy(asc(purchaseBillItems.lineOrder));

    return { ...header, items };
  }

  async listBillPayments(orgId: string, billId: number) {
    const bills = await this.db
      .select({ id: purchaseBills.id })
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, billId), eq(purchaseBills.orgId, orgId)))
      .limit(1);
    if (!bills[0]) throw new NotFoundException("Purchase bill not found");

    return this.db
      .select({
        id: vendorPayments.id,
        orgId: vendorPayments.orgId,
        billId: vendorPayments.billId,
        amount: vendorPayments.amount,
        paymentDate: vendorPayments.paymentDate,
        paymentMethod: vendorPayments.paymentMethod,
        referenceNumber: vendorPayments.referenceNumber,
        notes: vendorPayments.notes,
        createdBy: vendorPayments.createdBy,
        createdAt: vendorPayments.createdAt,
      })
      .from(vendorPayments)
      .where(and(eq(vendorPayments.billId, billId), eq(vendorPayments.orgId, orgId)))
      .orderBy(asc(vendorPayments.paymentDate), asc(vendorPayments.id))
      .limit(100);
  }

  listVendors(orgId: string, query: ListVendorsQuery) {
    return this.vendorQuery.listVendors(orgId, query);
  }

  vendorLedger(orgId: string, vendorId: number) {
    return this.vendorQuery.vendorLedger(orgId, vendorId);
  }

  agedPayables(orgId: string, query: AgedReceivablesQuery) {
    return this.vendorQuery.agedPayables(orgId, query);
  }
}
