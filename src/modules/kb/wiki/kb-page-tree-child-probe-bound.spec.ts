import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbPageTreeService } from "./kb-page-tree.service";

function makeUser(orgId: string) {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

const audit = {} as never;
const access = {} as never;
const kbAccess = {
  assertSpaceAccessible: jest.fn().mockResolvedValue(undefined),
} as never;

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn(),
  };
}

function levelRow(id: number) {
  return {
    id,
    parentPageId: null,
    spaceId: null,
    projectId: null,
    title: `Page ${id}`,
    icon: null,
    coverImage: null,
    sortOrder: id * 100,
    visibility: "org",
    createdById: "user-1",
    status: "published",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

interface ProbeHarness {
  db: Db;
  plainSelect: jest.Mock;
  distinctSelect: jest.Mock;
}

function makeHarness(
  levelRows: ReturnType<typeof levelRow>[],
  distinctParents: { parentPageId: number | null }[],
): ProbeHarness {
  const plainSelect = jest.fn().mockImplementation(() => ({
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve(distinctParents), {
          orderBy: () => ({ limit: () => Promise.resolve(levelRows) }),
        }),
    }),
  }));

  const distinctSelect = jest.fn().mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(distinctParents) }),
  }));

  const db = {
    select: plainSelect,
    selectDistinct: distinctSelect,
  } as unknown as Db;

  return { db, plainSelect, distinctSelect };
}

describe("KbPageTreeService.getTreeLevel — the has-children probe is bounded by the page, not the tenant", () => {
  it("BITE: the probe is a DISTINCT over the parent ids, so it cannot return one row per child page", async () => {
    const harness = makeHarness([levelRow(1), levelRow(2)], [
      { parentPageId: 1 },
    ]);
    const svc = new KbPageTreeService(
      harness.db,
      audit,
      makeAuth() as never,
      access,
      kbAccess,
    );

    await svc.getTreeLevel(makeUser("org-large"), { limit: 2 });

    expect(harness.distinctSelect).toHaveBeenCalledTimes(1);
  });

  it("BITE: exactly one unbounded-shaped read remains, and it is the level read that carries the limit", async () => {
    const harness = makeHarness([levelRow(1), levelRow(2)], [
      { parentPageId: 1 },
    ]);
    const svc = new KbPageTreeService(
      harness.db,
      audit,
      makeAuth() as never,
      access,
      kbAccess,
    );

    await svc.getTreeLevel(makeUser("org-large"), { limit: 2 });

    expect(harness.plainSelect).toHaveBeenCalledTimes(1);
  });

  it("the level itself still answers with its rows and its cursor page, before and after the probe changes", async () => {
    const harness = makeHarness([levelRow(1), levelRow(2)], [
      { parentPageId: 1 },
    ]);
    const svc = new KbPageTreeService(
      harness.db,
      audit,
      makeAuth() as never,
      access,
      kbAccess,
    );

    const page = await svc.getTreeLevel(makeUser("org-large"), { limit: 2 });

    expect(page.data.map((row) => row.id)).toEqual([1, 2]);
    expect(page.pagination.hasMore).toBe(false);
  });

  it("hasChildren stays true only for the parents the probe returned", async () => {
    const harness = makeHarness([levelRow(1), levelRow(2)], [
      { parentPageId: 1 },
    ]);
    const svc = new KbPageTreeService(
      harness.db,
      audit,
      makeAuth() as never,
      access,
      kbAccess,
    );

    const page = await svc.getTreeLevel(makeUser("org-large"), { limit: 2 });

    expect(page.data.find((row) => row.id === 1)?.hasChildren).toBe(true);
    expect(page.data.find((row) => row.id === 2)?.hasChildren).toBe(false);
  });
});
