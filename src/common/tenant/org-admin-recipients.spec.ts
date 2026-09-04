import type { Db } from "../../db/drizzle.module";
import { getOrgAdminRecipients, getOrgAdminUserIds } from "./org-admin-recipients";

/**
 * `getOrgAdminUserIds` selected every ACTIVE OWNER/ORG_ADMIN membership for an
 * org with no `limit` at all — the repo's own unbounded-read classification
 * banked it with "'an org has few admins' is a convention, not a cap". It is
 * the recipient list for org-wide administrative notifications, so a plain cap
 * would have been worse than the unbounded read: the administrators past the
 * cap would silently stop being told. It drains by keyset instead — every
 * query bounded, every row returned.
 *
 * The fixture is deliberately larger than one page. A fixture inside the page
 * cannot tell a drain from a cap, and cannot see an unbounded read at all.
 */

const PAGE_SIZE = 500;
const ADMIN_COUNT = PAGE_SIZE * 2 + 7;
const ORG = "org-1";

interface MemberRow {
  id: number;
  userId: string;
}

const ADMINS: MemberRow[] = Array.from(
  { length: ADMIN_COUNT },
  (_unused, index) => ({ id: index + 1, userId: `admin-${index}` }),
);

interface Harness {
  db: Db;
  limits: () => number[];
  unboundedReads: () => number;
}

/**
 * Every chain node is awaitable. Awaiting one BEFORE `.limit()` is what the old
 * implementation did, so that path is recorded rather than hidden — a mock that
 * only answers `.limit()` would make an unbounded read look like no read.
 */
function makeDb(rows: MemberRow[]): Harness {
  const limits: number[] = [];
  let unbounded = 0;
  let cursor = 0;

  const unboundedResult = (): Promise<MemberRow[]> => {
    unbounded += 1;
    return Promise.resolve(rows);
  };

  const node = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      from: () => node(),
      where: () => node(),
      orderBy: () => node(),
      limit: (count: number) => {
        limits.push(count);
        const page = rows.slice(cursor, cursor + count);
        cursor += page.length;
        return Promise.resolve(page);
      },
      then: (
        resolve: (value: MemberRow[]) => unknown,
        reject: (reason: unknown) => unknown,
      ) => unboundedResult().then(resolve, reject),
    };
    return self;
  };

  const db = { select: () => node() };

  return {
    db: db as unknown as Db,
    limits: () => limits,
    unboundedReads: () => unbounded,
  };
}

describe("getOrgAdminUserIds drains the admin roster", () => {
  it("ANTI-VACUITY: the fixture holds more admins than one page", () => {
    expect(ADMINS.length).toBeGreaterThan(PAGE_SIZE);
  });

  it("never issues a read without a limit", async () => {
    const harness = makeDb(ADMINS);

    await getOrgAdminUserIds(harness.db, ORG);

    expect(harness.unboundedReads()).toBe(0);
    expect(harness.limits().length).toBeGreaterThan(0);
    for (const limit of harness.limits()) expect(limit).toBe(PAGE_SIZE);
  });

  it("returns every admin, including the ones past the first page", async () => {
    const harness = makeDb(ADMINS);

    const ids = await getOrgAdminUserIds(harness.db, ORG);

    expect(ids).toHaveLength(ADMIN_COUNT);
    expect(new Set(ids).size).toBe(ADMIN_COUNT);
    const beyondFirstPage = ADMINS.slice(PAGE_SIZE).map((row) => row.userId);
    expect(beyondFirstPage.length).toBeGreaterThan(0);
    expect(ids).toEqual(expect.arrayContaining(beyondFirstPage));
  });

  it("stops as soon as a page comes back short, rather than looping", async () => {
    const harness = makeDb(ADMINS.slice(0, 3));

    const ids = await getOrgAdminUserIds(harness.db, ORG);

    expect(ids).toHaveLength(3);
    expect(harness.limits()).toHaveLength(1);
  });

  it("folds the extra recipients in without losing a drained admin", async () => {
    const harness = makeDb(ADMINS);

    const ids = await getOrgAdminRecipients(harness.db, ORG, [
      "actor-1",
      null,
      undefined,
      "admin-0",
    ]);

    expect(ids).toHaveLength(ADMIN_COUNT + 1);
    expect(ids).toContain("actor-1");
    expect(ids).toContain(ADMINS[ADMIN_COUNT - 1]?.userId);
  });
});
