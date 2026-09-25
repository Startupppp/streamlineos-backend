import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, ilike, isNull } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBefore } from "../../common/pagination/keyset";
import { clientAccounts, deals, projects, quotes, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import type { ListInput } from "./dto/quote.schemas";

const LIST_TTL = 30;

@Injectable()
export class QuotesQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async list(orgId: string, filters: ListInput) {
    const { status, dealId, search, cursor, pageSize } = filters;
    const limit = pageSize;

    const key = `${status ?? ""}:${dealId ?? ""}:${search ?? ""}:${limit}:${cursor ?? ""}`;
    return this.cache.cachedVersioned(
      `quotes:list:${orgId}`,
      key,
      async () => {
        const conditions = [eq(quotes.orgId, orgId), isNull(quotes.deletedAt)];
        if (status) conditions.push(eq(quotes.status, status));
        if (dealId) conditions.push(eq(quotes.dealId, dealId));
        if (search) conditions.push(ilike(quotes.subject, `%${search}%`));

        const position = decodeCursor(cursor);
        const where = position
          ? and(...conditions, keysetBefore(quotes.createdAt, quotes.id, position))
          : and(...conditions);

        const [rows, totalResult] = await Promise.all([
          this.db
            .select({
              id: quotes.id,
              orgId: quotes.orgId,
              dealId: quotes.dealId,
              clientId: quotes.clientId,
              quoteNumber: quotes.quoteNumber,
              subject: quotes.subject,
              status: quotes.status,
              currency: quotes.currency,
              totalAmount: quotes.totalAmount,
              netAmount: quotes.netAmount,
              validUntil: quotes.validUntil,
              createdById: quotes.createdById,
              sentAt: quotes.sentAt,
              acceptedAt: quotes.acceptedAt,
              createdAt: quotes.createdAt,
              updatedAt: quotes.updatedAt,
              createdByName: users.name,
              createdByImage: users.image,
              dealName: deals.name,
              clientName: clientAccounts.clientName,
            })
            .from(quotes)
            .leftJoin(users, eq(quotes.createdById, users.id))
            .leftJoin(deals, eq(quotes.dealId, deals.id))
            .leftJoin(clientAccounts, eq(quotes.clientId, clientAccounts.id))
            .where(where)
            .orderBy(desc(quotes.createdAt), desc(quotes.id))
            .limit(limit + 1),
          cursor === undefined
            ? this.db.select({ count: count() }).from(quotes).where(and(...conditions))
            : Promise.resolve(null),
        ]);

        const page = buildCursorPage(rows, limit, (q) => ({ sortValue: q.createdAt.toISOString(), id: String(q.id) }));
        return {
          quotes: page.data.map((q) => ({
            ...q,
            createdBy: q.createdByName
              ? { id: q.createdById, name: q.createdByName, image: q.createdByImage }
              : null,
            deal: q.dealId ? { id: q.dealId, name: q.dealName } : null,
            client: q.clientId ? { id: q.clientId, clientName: q.clientName } : null,
          })),
          hasMore: page.pagination.hasMore,
          nextCursor: page.pagination.nextCursor,
          total: totalResult ? (totalResult[0]?.count ?? 0) : undefined,
        };
      },
      LIST_TTL,
    );
  }

  async getQuote(orgId: string, quoteId: number) {
    const quote = await this.db.query.quotes.findFirst({
      where: and(eq(quotes.id, quoteId), eq(quotes.orgId, orgId), isNull(quotes.deletedAt)),
      with: {
        lineItems: { orderBy: (li, { asc }) => [asc(li.displayOrder)] },
        createdBy: { columns: { id: true, name: true, image: true } },
        deal: { columns: { id: true, name: true } },
        client: { columns: { id: true, clientName: true } },
      },
    });

    if (!quote || quote.dealId == null) return quote;

    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.orgId, orgId), eq(projects.dealId, quote.dealId), isNull(projects.deletedAt)),
      columns: { id: true },
    });

    return { ...quote, projectId: project?.id ?? null };
  }
}
