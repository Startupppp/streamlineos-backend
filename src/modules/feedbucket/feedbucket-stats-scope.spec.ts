import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { FeedbucketMediaStorage } from "./feedbucket-submissions.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";
import { ScopedRead } from "../access/scoped-read";

const dialect = new PgDialect();
const ORG = "org-a";
const userId = "user-stats";

const mockStorage: jest.Mocked<FeedbucketMediaStorage> = {
  deleteFileIfPresent: jest.fn(),
};

function makeDb(sink: { where?: SQL }) {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (w: SQL) => {
      sink.where = w;
      return chain;
    },
    groupBy: () => Promise.resolve([]),
  };
  return chain as never;
}

describe("FeedbucketSubmissionsService.stats scope application", () => {
  it("stats aggregate must not use an unrestricted predicate when only team is granted", async () => {
    const sink: { where?: SQL } = {};
    const service = new FeedbucketSubmissionsService(
      makeDb(sink),
      mockStorage,
      {} as unknown as import("../access/access.service").AccessService,
    );

    await service.stats(ScopedRead.of(ORG, userId, "team"), null);

    const rendered = dialect.sqlToQuery(sink.where as SQL).sql;
    expect(rendered).not.toBe("true");
  });

  it("stats aggregate must deny none scope outright, never reaching the database", async () => {
    const sink: { where?: SQL } = {};
    const service = new FeedbucketSubmissionsService(
      makeDb(sink),
      mockStorage,
      {} as unknown as import("../access/access.service").AccessService,
    );

    const result = await service.stats(ScopedRead.of(ORG, userId, "none"), null);

    expect(sink.where).toBeUndefined();
    expect(result).toEqual({ byStatus: {}, byType: {} });
  });
});
