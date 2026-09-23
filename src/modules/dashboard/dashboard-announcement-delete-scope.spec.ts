import type { Db } from "../../db/drizzle.module";
import { DashboardAnnouncementsService } from "./dashboard-announcements.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  )
    return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value")
      ? sqlValues(r.value, seen)
      : []),
  ];
}

const ORG = "org-1";

function makeService(holds: boolean) {
  const wheres: unknown[] = [];
  const db = {
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((a: unknown) => {
        wheres.push(a);
        return Promise.resolve([]);
      }),
    }),
  } as unknown as Db;
  const cache = { invalidateForOrg: jest.fn() } as never;
  const access = { holds: jest.fn().mockResolvedValue(holds) } as never;
  return {
    svc: new DashboardAnnouncementsService(db, cache, access),
    wheres,
    db,
  };
}

describe("Home announcement delete cannot reach targeted broadcasts", () => {
  it("restricts the delete to org-wide broadcasts so settings:manage cannot remove a role or department targeted one", async () => {
    const { svc, wheres } = makeService(true);

    await svc.deleteAnnouncement(ORG, {} as never, 5);

    expect(wheres.length).toBe(1);
    const values = sqlValues(wheres[0]);
    expect(values).toContain("all");
  });

  it("still scopes the delete to the requesting org", async () => {
    const { svc, wheres } = makeService(true);

    await svc.deleteAnnouncement(ORG, {} as never, 5);

    expect(sqlValues(wheres[0])).toContain(ORG);
  });

  it("deletes nothing when the actor does not hold settings:manage", async () => {
    const { svc, db } = makeService(false);

    const result = await svc.deleteAnnouncement(ORG, {} as never, 5);

    expect(result).toEqual({ error: "forbidden", message: "Forbidden" });
    expect(db.delete).not.toHaveBeenCalled();
  });
});
