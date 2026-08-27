import { PgDialect } from "drizzle-orm/pg-core";
import { ScopedRead } from "./object-access";
import { organizationMembers } from "../../db/schema";
import type { DataScope } from "./access.types";

const dialect = new PgDialect();
const sqlOf = (read: ScopedRead) =>
  dialect.sqlToQuery(read.predicate({ ownerColumn: organizationMembers.userId })).sql;

const accessHolding = (map: Record<string, DataScope>) => ({
  resolveUserPermissions: () => Promise.resolve(new Map(Object.entries(map))),
});

const ACTOR = { orgId: "org-1", userId: "u-1" };

describe("ScopedRead.resolve", () => {
  it("carries the scope the caller holds for that key", async () => {
    const read = await ScopedRead.resolve(
      accessHolding({ "hr:leaves:approve": "own" }),
      ACTOR,
      "hr:leaves:approve",
    );
    expect(read.denied).toBe(false);
    expect(read.discriminator).toBe("own");
  });

  it("falls to none for a key the caller does not hold", async () => {
    const read = await ScopedRead.resolve(accessHolding({}), ACTOR, "hr:leaves:approve");
    expect(read.denied).toBe(true);
  });

  // A typo in a permission key is the likeliest way to reach this code wrongly
  it("falls to none for a key that exists nowhere, so a typo denies", async () => {
    const read = await ScopedRead.resolve(
      accessHolding({ "hr:leaves:approve": "all" }),
      ACTOR,
      "hr:leaves:aprove",
    );
    expect(read.denied).toBe(true);
    expect(sqlOf(read)).toBe("false");
  });
});

describe("ScopedRead.predicate", () => {
  it("renders none as false, so a caller who forgets to refuse none is still denied", () => {
    expect(sqlOf(ScopedRead.of("org-1", "u-1", "none"))).toBe("false");
  });

  it("renders all as true", () => {
    expect(sqlOf(ScopedRead.of("org-1", "u-1", "all"))).toBe("true");
  });

  it("renders own as an owner-column equality on the actor", () => {
    const rendered = sqlOf(ScopedRead.of("org-1", "u-1", "own"));
    expect(rendered).toContain("user_id");
    expect(rendered).toContain("=");
  });
});

describe("ScopedRead as a seam", () => {
  // The whole design: there is no way to read the scope out except as SQL or as a discriminator that is named for not being a filter
  it("exposes no accessor that yields the bare scope", () => {
    const read = ScopedRead.of("org-1", "u-1", "own");
    const surface = [
      ...Object.getOwnPropertyNames(read),
      ...Object.getOwnPropertyNames(ScopedRead.prototype),
    ];
    expect(surface).not.toContain("scope");
  });

  it("names the cache discriminator for what it is, not for what it is not", () => {
    const read = ScopedRead.of("org-1", "u-1", "team");
    expect(`${read.discriminator}:2026`).toBe("team:2026");
  });

  it("keeps the actor and tenant it was resolved for", () => {
    const read = ScopedRead.of("org-9", "u-9", "own");
    expect(read.orgId).toBe("org-9");
    expect(read.actorId).toBe("u-9");
    expect(read.context()).toEqual({ orgId: "org-9", actorId: "u-9", scope: "own" });
  });
});
