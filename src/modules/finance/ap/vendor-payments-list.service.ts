import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { vendorPayments, purchaseBills, clients } from "../../../db/schema";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeValue } from "../../../common/pagination/keyset";
import type { ListVendorPaymentsQuery } from "./dto/finance-ap.schemas";

@Injectable()
export class VendorPaymentsListService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: ListVendorPaymentsQuery) {
    const { cursor, limit, vendorId, from, to } = query;
    const pos = decodeCursor(cursor);
    const pageLimit = Math.min(limit, 100);

    const conds = [eq(vendorPayments.orgId, orgId)];
    if (vendorId) conds.push(eq(purchaseBills.vendorId, vendorId));
    if (from) conds.push(gte(vendorPayments.paymentDate, from));
    if (to) conds.push(lte(vendorPayments.paymentDate, to));
    if (pos) conds.push(keysetBeforeValue(vendorPayments.paymentDate, vendorPayments.id, pos));

    const rows = await this.db
      .select({
        id: vendorPayments.id,
        orgId: vendorPayments.orgId,
        billId: vendorPayments.billId,
        billNumber: purchaseBills.billNumber,
        vendorId: purchaseBills.vendorId,
        vendorName: clients.name,
        amount: vendorPayments.amount,
        paymentDate: vendorPayments.paymentDate,
        paymentMethod: vendorPayments.paymentMethod,
        referenceNumber: vendorPayments.referenceNumber,
        notes: vendorPayments.notes,
        createdBy: vendorPayments.createdBy,
        createdAt: vendorPayments.createdAt,
      })
      .from(vendorPayments)
      .leftJoin(purchaseBills, eq(purchaseBills.id, vendorPayments.billId))
      .leftJoin(clients, eq(clients.id, purchaseBills.vendorId))
      .where(and(...conds))
      .orderBy(desc(vendorPayments.paymentDate), desc(vendorPayments.id))
      .limit(pageLimit + 1);

    return buildCursorPage(rows, pageLimit, (row) => ({
      sortValue: row.paymentDate ?? "",
      id: String(row.id),
    }));
  }
}
