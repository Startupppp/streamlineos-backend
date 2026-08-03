import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { finExchangeRates } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { buildListResponse, paginateOffset } from "../../../common/pagination/pagination";
import type { UpsertExchangeRateInput, ListExchangeRatesQuery } from "./dto/finance-controls.schemas";

@Injectable()
export class ExchangeRatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, query: ListExchangeRatesQuery) {
    const { limit, offset } = paginateOffset(query);
    const condition = eq(finExchangeRates.orgId, orgId);

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select()
        .from(finExchangeRates)
        .where(condition)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(finExchangeRates)
        .where(condition),
    ]);

    return buildListResponse(rows, count, query);
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
