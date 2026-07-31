import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { vendorPayments, purchaseBills, clients } from "../../../db/schema";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import { sql } from "drizzle-orm";
import type { ListVendorPaymentsQuery } from "./dto/finance-ap.schemas";

@Injectable()
export class VendorPaymentsListService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: ListVendorPaymentsQuery) {
    const { page, pageSize, vendorId, from, to } = query;

    const conds = [eq(vendorPayments.orgId, orgId)];
    if (vendorId) conds.push(eq(purchaseBills.vendorId, vendorId));
    if (from) conds.push(gte(vendorPayments.paymentDate, from));
    if (to) conds.push(lte(vendorPayments.paymentDate, to));

    const { offset, limit } = paginateOffset({ page, pageSize });

    const [items, totals] = await Promise.all([
      this.db
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
        .orderBy(desc(vendorPayments.paymentDate), asc(vendorPayments.id))
        .offset(offset)
        .limit(limit),
      this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(vendorPayments)
        .leftJoin(purchaseBills, eq(purchaseBills.id, vendorPayments.billId))
        .where(and(...conds)),
    ]);

    return buildListResponse(items, Number(totals[0]?.c ?? 0), { page, pageSize });
  }
}
