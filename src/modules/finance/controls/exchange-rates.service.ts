import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { finExchangeRates } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeValue } from "../../../common/pagination/keyset";
import type { UpsertExchangeRateInput, ListExchangeRatesQuery } from "./dto/finance-controls.schemas";

@Injectable()
export class ExchangeRatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, query: ListExchangeRatesQuery): Promise<CursorPage<typeof finExchangeRates.$inferSelect>> {
    const pos = decodeCursor(query.cursor);
    const conditions = [eq(finExchangeRates.orgId, orgId)];
    if (pos) conditions.push(keysetBeforeValue(finExchangeRates.asOfDate, finExchangeRates.id, pos));

    const rows = await this.db
      .select()
      .from(finExchangeRates)
      .where(and(...conditions))
      .orderBy(desc(finExchangeRates.asOfDate), desc(finExchangeRates.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (r) => ({
      sortValue: String(r.asOfDate),
      id: String(r.id),
    }));
  }

  async upsert(orgId: string, userId: string, input: UpsertExchangeRateInput) {
    const [row] = await this.db
      .insert(finExchangeRates)
      .values({
        orgId,
        fromCurrency: input.fromCurrency,
        toCurrency: input.toCurrency,
        rate: input.rate,
        asOfDate: input.asOfDate,
      })
      .onConflictDoUpdate({
        target: [
          finExchangeRates.orgId,
          finExchangeRates.fromCurrency,
          finExchangeRates.toCurrency,
          finExchangeRates.asOfDate,
        ],
        set: { rate: input.rate },
      })
      .returning();

    if (!row) throw new Error("Exchange rate upsert returned no rows");

    this.audit.log({
      action: "accounting.exchange_rate.upsert",
      userId,
      orgId,
      resourceType: "exchange_rate",
      resourceId: String(row.id),
      metadata: { fromCurrency: input.fromCurrency, toCurrency: input.toCurrency, asOfDate: input.asOfDate },
      result: "SUCCESS",
    });

    return row;
  }
}
