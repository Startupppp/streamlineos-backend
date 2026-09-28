import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import type { FeedbucketMediaStorage } from "./feedbucket-submissions.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";
import type { ListSubmissionsQuery } from "./feedbucket.schemas";
import { ScopedRead } from "../access/scoped-read";

const dialect = new PgDialect();
const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const PRODUCT_ID = 42;

const mockStorage: jest.Mocked<FeedbucketMediaStorage> = {
  deleteFileIfPresent: jest.fn(),
};

function makeListDb(sink: { where?: SQL }): Db {
  const selectChain = {
    from: () => selectChain,
    where: (w: SQL) => {
      sink.where = w;
      return Promise.resolve([{ total: 0 }]);
    },
  };
  return {
    query: {
      feedbucketSubmissions: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      organizationMembers: { findFirst: jest.fn() },
    },
    select: () => selectChain,
  } as unknown as Db;
}

function baseQuery(): ListSubmissionsQuery {
  return { page: 1, limit: 20 };
}

describe("FeedbucketSubmissionsService.list — managedProductId filter", () => {
  it("renders managedProductId as a bound SQL parameter in the WHERE clause", async () => {
    const sink: { where?: SQL } = {};
    const service = new FeedbucketSubmissionsService(makeListDb(sink), mockStorage, {} as unknown as import("../access/access.service").AccessService);

    await service.list(ScopedRead.of(OWNER_ORG, "user-1", "all"), { ...baseQuery(), managedProductId: PRODUCT_ID }, null);

    const rendered = dialect.sqlToQuery(sink.where as SQL);
    expect(rendered.params).toContain(PRODUCT_ID);
    expect(rendered.sql).toContain('"feedbucket_widgets_scope"."managed_product_id"');
    expect(rendered.sql).not.toContain('"feedbucketSubmissions"."managed_product_id"');
  });

  it("does not include a managed_product_id predicate when managedProductId is absent", async () => {
    const sink: { where?: SQL } = {};
    const service = new FeedbucketSubmissionsService(makeListDb(sink), mockStorage, {} as unknown as import("../access/access.service").AccessService);

    await service.list(ScopedRead.of(OWNER_ORG, "user-1", "all"), baseQuery(), null);

    const rendered = dialect.sqlToQuery(sink.where as SQL);
    expect(rendered.sql).not.toContain("managed_product_id");
    expect(rendered.params).not.toContain(PRODUCT_ID);
  });

  it("cross-tenant isolation: subquery binds the caller orgId so a foreign managedProductId matches no widgets", async () => {
    const sink: { where?: SQL } = {};
    const service = new FeedbucketSubmissionsService(makeListDb(sink), mockStorage, {} as unknown as import("../access/access.service").AccessService);

    await service.list(ScopedRead.of(ATTACKER_ORG, "user-attacker", "all"), { ...baseQuery(), managedProductId: PRODUCT_ID }, null);

    const rendered = dialect.sqlToQuery(sink.where as SQL);
    expect(rendered.params).toContain(ATTACKER_ORG);
    expect(rendered.params).not.toContain(OWNER_ORG);
  });
});
