import { NotFoundException } from "@nestjs/common";
import { assertUsersInOrg, filterOrgMemberIds, isOrgMember } from "../org-membership";
import type { Db } from "../../../db/drizzle.module";

function dbReturning(rows: { userId: string }[]): { db: Db; calls: number } {
  const state = { calls: 0 };
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          state.calls += 1;
          return Promise.resolve(rows);
        },
      }),
    }),
  } as unknown as Db;
  return { db, get calls() { return state.calls; } };
}

describe("filterOrgMemberIds", () => {
  it("returns only the ids the membership query confirmed", async () => {
    const { db } = dbReturning([{ userId: "u1" }]);
    await expect(filterOrgMemberIds(db, "org-a", ["u1", "u2"])).resolves.toEqual(["u1"]);
  });

  it("short-circuits without querying when given no ids", async () => {
    const handle = dbReturning([]);
    await expect(filterOrgMemberIds(handle.db, "org-a", [])).resolves.toEqual([]);
    expect(handle.calls).toBe(0);
  });

  it("short-circuits when every id is falsy", async () => {
    const handle = dbReturning([]);
    await expect(filterOrgMemberIds(handle.db, "org-a", ["", ""])).resolves.toEqual([]);
    expect(handle.calls).toBe(0);
  });
});

describe("assertUsersInOrg", () => {
  it("passes when every id belongs to the org", async () => {
    const { db } = dbReturning([{ userId: "u1" }, { userId: "u2" }]);
    await expect(assertUsersInOrg(db, "org-a", ["u1", "u2"])).resolves.toBeUndefined();
  });

  it("throws NotFound — not Forbidden — when an id is foreign", async () => {
    const { db } = dbReturning([{ userId: "u1" }]);
    await expect(assertUsersInOrg(db, "org-a", ["u1", "outsider"])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("throws when the org has no matching members at all", async () => {
    const { db } = dbReturning([]);
    await expect(assertUsersInOrg(db, "org-a", ["outsider"])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("deduplicates before comparing so a repeated valid id still passes", async () => {
    const { db } = dbReturning([{ userId: "u1" }]);
    await expect(assertUsersInOrg(db, "org-a", ["u1", "u1"])).resolves.toBeUndefined();
  });
});

describe("isOrgMember", () => {
  it("is true only when the id comes back", async () => {
    const { db } = dbReturning([{ userId: "u1" }]);
    await expect(isOrgMember(db, "org-a", "u1")).resolves.toBe(true);
  });

  it("is false when nothing comes back", async () => {
    const { db } = dbReturning([]);
    await expect(isOrgMember(db, "org-a", "u1")).resolves.toBe(false);
  });
});
