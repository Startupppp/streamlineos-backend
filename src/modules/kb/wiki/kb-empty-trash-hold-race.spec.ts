import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KbPageTrashService } from "./kb-page-trash.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const dialect = new PgDialect();
const ORG = "org-empty-trash";

const user = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
} as CurrentUserContext;

jest.mock("./kb-page-attachment-purge", () => ({
  recordPageAttachmentPurge: jest.fn().mockResolvedValue([]),
  attemptPageAttachmentPurge: jest.fn().mockResolvedValue(undefined),
  purgeOrphanedKbMedia: jest.fn().mockResolvedValue(0),
}));

function makeDb(): { db: Db; deleteWheres: SQL[] } {
  const deleteWheres: SQL[] = [];
  let listed = false;

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    for: () => selectChain,
    limit: async () => {
      if (listed) return [];
      listed = true;
      return [{ id: 11 }];
    },
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  };

  const db = {
    select: jest.fn(() => selectChain),
    execute: jest.fn().mockResolvedValue([]),
    delete: jest.fn(() => ({
      where: (cond: SQL) => {
        deleteWheres.push(cond);
        return { returning: async () => [{ id: 11 }] };
      },
    })),
    insert: () => ({
      values: () => ({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }),
    }),
    update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue([]) }) }),
    transaction: jest.fn(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
    ),
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
      kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  } as unknown as Db;

  return { db, deleteWheres };
}

function service(db: Db): KbPageTrashService {
  return new KbPageTrashService(
    db,
    { log: jest.fn() } as never,
    {} as never,
    { R2_KB_BUCKET_NAME: "test-bucket" } as never,
    {
      visiblePagePredicate: jest.fn().mockResolvedValue(undefined),
      assertPageAccess: jest.fn().mockResolvedValue(undefined),
    } as never,
    { restore: jest.fn() } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

describe("emptyTrash cannot purge a page whose legal hold landed after the batch was listed", () => {
  it("carries legal_hold = false in the DELETE predicate itself, not only in the SELECT that chose the batch, because a hold placed between the two would otherwise destroy a held page", async () => {
    const { db, deleteWheres } = makeDb();

    await service(db).emptyTrash(user);

    expect(deleteWheres.length).toBeGreaterThan(0);

    const rendered = deleteWheres
      .map((cond) => dialect.sqlToQuery(cond))
      .filter((q) => q.sql.includes('"kb_pages"'));

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.sql).toContain("legal_hold");
    expect(rendered[0]?.params).toContain(ORG);
  });

  it("CONTROL: the store-purge deletes in the same flow carry no legal_hold predicate, so the assertion above is reading the page delete and not any delete at all", async () => {
    const { db, deleteWheres } = makeDb();

    await service(db).emptyTrash(user);

    const storeDeletes = deleteWheres
      .map((cond) => dialect.sqlToQuery(cond))
      .filter((q) => !q.sql.includes('"kb_pages"'));

    expect(storeDeletes.length).toBeGreaterThan(0);
    expect(storeDeletes.every((q) => !q.sql.includes("legal_hold"))).toBe(true);
  });
});
