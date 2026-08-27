import { Inject, Injectable } from "@nestjs/common";
import { partyNamesFor } from "../party/party-names";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { invoices, payments } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import type { ListInvoicesInput } from "./dto/invoice.schemas";

const LIST_TTL = 30;

export interface RecurringInvoiceRow {
  id: number;
  invoiceNumber: string;
  clientId: number | null;
  clientName: string | null;
  total: string;
  currency: string;
  status: string;
  recurringInterval: string | null;
  nextRecurringDate: string | null;
  overdue: boolean;
}

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async list(orgId: string, filters: ListInvoicesInput) {
    const { status, clientId, page, limit } = filters;
    const offset = (page - 1) * limit;

    const key = `invoices:list:${orgId}:${status ?? ""}:${clientId ?? ""}:${limit}:${offset}`;
    return this.cache.cached(
      key,
      async () => {
        const conditions = [eq(invoices.orgId, orgId)];
        if (status) conditions.push(eq(invoices.status, status));
        if (clientId) conditions.push(eq(invoices.clientId, clientId));

        const where = and(...conditions);

        const [items, countResult] = await Promise.all([
          this.db.query.invoices.findMany({
            where,
            orderBy: [desc(invoices.createdAt)],
            limit,
            offset,
            with: {
              project: { columns: { id: true, name: true } },
              creator: { columns: { id: true, name: true } },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invoices)
            .where(where),
        ]);

        /**
         * The client's name from Party, not from `clients`. Ticket 08.
         *
         * `client_id` is still what the invoice is filed under and is still
         * returned as `client.id`, so nothing downstream changes shape; only the
         * name moved. `invoices.client_id` is one of the twelve foreign keys
         * standing between the CRM and dropping the legacy tables.
         */
        const names = await partyNamesFor(this.db, orgId, items.map((i) => i.clientPartyId));
        const withClient = items.map((invoice) => ({
          ...invoice,
          client: invoice.clientId
            ? {
                id: invoice.clientId,
                name: invoice.clientPartyId ? (names.get(invoice.clientPartyId) ?? null) : null,
              }
            : null,
        }));

        const total = countResult[0]?.count ?? 0;
        return {
          items: withClient,
          total,
          page,
          totalPages: Math.ceil(total / limit),
        };
      },
      LIST_TTL,
    );
  }

  getInvoice(orgId: string, invoiceId: number) {
    return this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId)),
      with: {
        client: true,
        project: { columns: { id: true, name: true } },
        creator: { columns: { id: true, name: true } },
        payments: {
          orderBy: [desc(payments.paymentDate)],
          with: { creator: { columns: { id: true, name: true } } },
        },
      },
    });
  }

  getInvoicePayments(orgId: string, invoiceId: number) {
    return this.db.query.payments.findMany({
      where: and(eq(payments.invoiceId, invoiceId), eq(payments.orgId, orgId)),
      orderBy: [desc(payments.paymentDate)],
      with: { creator: { columns: { id: true, name: true } } },
    });
  }

  async getStats(orgId: string) {
    const results = await this.db
      .select({
        status: invoices.status,
        count: sql<number>`count(*)::int`,
        total: sql<number>`COALESCE(sum(${invoices.total}::numeric), 0)::float`,
      })
      .from(invoices)
      .where(eq(invoices.orgId, orgId))
      .groupBy(invoices.status);

    const stats = {
      draft: 0,
      issued: 0,
      paid: 0,
      failed: 0,
      voided: 0,
      totalOutstanding: 0,
      totalPaid: 0,
    };
    for (const r of results) {
      const s = r.status.toLowerCase() as keyof typeof stats;
      if (s in stats) (stats as Record<string, number>)[s] = r.count;
      if (r.status === "ISSUED" || r.status === "FAILED") stats.totalOutstanding += r.total;
      if (r.status === "PAID") stats.totalPaid += r.total;
    }
    return stats;
  }

  async listRecurring(orgId: string, asOfDate: string): Promise<RecurringInvoiceRow[]> {
    const rows = await this.db.query.invoices.findMany({
      where: and(eq(invoices.orgId, orgId), eq(invoices.isRecurring, true)),
      orderBy: [asc(invoices.nextRecurringDate)],
      columns: {
        id: true,
        invoiceNumber: true,
        clientId: true,
        total: true,
        currency: true,
        status: true,
        recurringInterval: true,
        nextRecurringDate: true,
        clientPartyId: true,
      },
    });

    // Ticket 08: the name comes from Party; `clientId` is unchanged.
    const names = await partyNamesFor(this.db, orgId, rows.map((r) => r.clientPartyId));

    return rows.map((row) => ({
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      clientId: row.clientId,
      clientName: row.clientPartyId ? (names.get(row.clientPartyId) ?? null) : null,
      total: row.total,
      currency: row.currency,
      status: row.status,
      recurringInterval: row.recurringInterval,
      nextRecurringDate: row.nextRecurringDate,
      overdue: row.nextRecurringDate !== null && row.nextRecurringDate <= asOfDate,
    }));
  }
}
