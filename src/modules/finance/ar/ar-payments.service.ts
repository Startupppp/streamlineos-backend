import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { payments, invoices, clients, finPaymentAllocations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import type { ListArPaymentsQuery } from "./dto/finance-ar.schemas";

@Injectable()
export class ArPaymentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: ListArPaymentsQuery) {
    const { limit, offset } = paginateOffset(query);
    const conditions = [eq(payments.orgId, orgId)];

    if (query.method) conditions.push(eq(payments.paymentMethod, query.method));
    if (query.from) conditions.push(gte(payments.paymentDate, query.from));
    if (query.to) conditions.push(lte(payments.paymentDate, query.to));

    const joinedConditions = query.clientId
      ? [...conditions, eq(invoices.clientId, query.clientId)]
      : conditions;

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select({
          id: payments.id,
          orgId: payments.orgId,
          invoiceId: payments.invoiceId,
          amount: payments.amount,
          paymentDate: payments.paymentDate,
          paymentMethod: payments.paymentMethod,
          referenceNumber: payments.referenceNumber,
          notes: payments.notes,
          createdAt: payments.createdAt,
          invoiceNumber: invoices.invoiceNumber,
          clientId: invoices.clientId,
          clientName: clients.name,
        })
        .from(payments)
        .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
        .leftJoin(clients, eq(invoices.clientId, clients.id))
        .where(and(...joinedConditions))
        .orderBy(desc(payments.paymentDate), desc(payments.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(payments)
        .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
        .where(and(...joinedConditions)),
    ]);

    const paymentIds = rows.map((r) => r.id);
    const allocations =
      paymentIds.length > 0
        ? await this.db
            .select({
              paymentId: finPaymentAllocations.paymentId,
              invoiceId: finPaymentAllocations.invoiceId,
              amount: finPaymentAllocations.amount,
            })
            .from(finPaymentAllocations)
            .where(inArray(finPaymentAllocations.paymentId, paymentIds))
        : [];

    const allocationsByPayment = new Map<number, { invoiceId: number; amount: string }[]>();
    for (const alloc of allocations) {
      const existing = allocationsByPayment.get(alloc.paymentId) ?? [];
      existing.push({ invoiceId: alloc.invoiceId, amount: alloc.amount });
      allocationsByPayment.set(alloc.paymentId, existing);
    }

    const items = rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      clientId: r.clientId ?? null,
      clientName: r.clientName ?? null,
      amount: r.amount,
      paymentDate: r.paymentDate,
      paymentMethod: r.paymentMethod,
      referenceNumber: r.referenceNumber,
      notes: r.notes,
      createdAt: r.createdAt,
      allocations: allocationsByPayment.get(r.id) ?? [],
    }));

    return buildListResponse(items, count, query);
  }
}
