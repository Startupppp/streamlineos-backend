import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { TimesheetsService } from "./timesheets.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { AccessService } from "../../access/access.service";
import { EntriesPeriodService } from "../../timesheets/core/entries-period.service";
import { timeEntriesListQuerySchema, teamTimesheetsQuerySchema } from "./dto/timesheets.schemas";
import { encodeCursor } from "../../../common/pagination/cursor";
import { systemActor } from "../../../common/auth/system-actor";

describe("Build timesheet cursor pages", () => {
  it.each(["list", "team"])("%s returns a stable bounded page without offset", async (kind) => {
    const findMany = jest.fn().mockResolvedValue([{ id: 8, date: "2026-09-09" }, { id: 7, date: "2026-09-09" }]);
    const module = await Test.createTestingModule({ providers: [TimesheetsService,
      { provide: DRIZZLE, useValue: { query: { timesheets: { findMany } }, select: () => ({ from: () => ({ where: async () => [{ total: 10 }] }) }) } },
      { provide: CacheService, useValue: {} }, { provide: AccessService, useValue: { scopeFor: async () => "all" } },
      { provide: EntriesPeriodService, useValue: {} },
    ] }).compile();
    const service = module.get(TimesheetsService);
    const cursor = encodeCursor({ sortValue: "2026-09-09", id: "9" });
    const actor = systemActor("build.daily-snapshots", "org-a");
    const result = kind === "list"
      ? await service.listTimeEntries(actor, timeEntriesListQuerySchema.parse({ cursor, limit: 1 }))
      : await service.teamTimesheets(actor, teamTimesheetsQuerySchema.parse({ cursor, limit: 1 }));
    expect(result).toMatchObject({ items: [{ id: 8 }], hasMore: true, nextCursor: encodeCursor({ sortValue: "2026-09-09", id: "8" }), total: 10, pageSize: 1 });
    expect(result).not.toHaveProperty("page");
    const options = findMany.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty("offset");
    expect(options.limit).toBe(2);
    expect(options.orderBy).toHaveLength(2);
    expect(new PgDialect().sqlToQuery(options.where).sql).toContain("<");
    await module.close();
  });
});
