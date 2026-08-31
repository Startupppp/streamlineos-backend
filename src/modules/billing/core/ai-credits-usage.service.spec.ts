import { Test } from "@nestjs/testing";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiCreditsUsageService } from "./ai-credits-usage.service";

const dialect = new PgDialect();

function renderSql(value: unknown): string {
  if (!(value instanceof SQL)) throw new Error("Expected a Drizzle SQL predicate");
  return dialect.sqlToQuery(value).sql;
}

function makeDb() {
  const predicates: string[] = [];
  const chain: {
    from: () => typeof chain;
    where: (condition: unknown) => typeof chain;
    groupBy: () => Promise<never[]>;
    limit: () => Promise<never[]>;
    then: (resolve: (rows: never[]) => unknown) => unknown;
  } = {
    from: () => chain,
    where: (condition) => {
      predicates.push(renderSql(condition));
      return chain;
    },
    groupBy: () => Promise.resolve([]),
    limit: () => Promise.resolve([]),
    then: (resolve) => resolve([]),
  };

  return { db: { select: jest.fn(() => chain) }, predicates };
}

async function buildService(db: unknown): Promise<AiCreditsUsageService> {
  const moduleRef = await Test.createTestingModule({
    providers: [AiCreditsUsageService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return moduleRef.get(AiCreditsUsageService);
}

describe("AiCreditsUsageService — tenant isolation", () => {
  it("excludes a different org's usage from every aggregate sharing the same date range", async () => {
    const { db, predicates } = makeDb();
    const service = await buildService(db);

    await service.getUsage("org-a", 30);

    expect(predicates.length).toBeGreaterThanOrEqual(4);
    for (const predicate of predicates) {
      if (predicate.includes('"org_id"')) {
        expect(predicate).toContain('"org_id" =');
      }
    }
  });

  it("returns lifetimeConsumedCredits and lifetimeConsumedMilli in the result", async () => {
    const { db } = makeDb();
    const service = await buildService(db);

    const result = await service.getUsage("org-a", 30);

    expect(result).toHaveProperty("lifetimeConsumedCredits");
    expect(result).toHaveProperty("lifetimeConsumedMilli");
    expect(typeof result.lifetimeConsumedCredits).toBe("number");
    expect(typeof result.lifetimeConsumedMilli).toBe("number");
  });
});
