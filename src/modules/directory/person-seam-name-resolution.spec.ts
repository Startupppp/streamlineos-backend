import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema";
import {
  NAME_RESOLUTION_MAX_CANDIDATES,
  NAME_RESOLUTION_MAX_NAMES,
  peopleByNameQuery,
  resolvePeopleByName,
} from "./person-seam";
import type { Db } from "../../db/drizzle.module";

function compile(orgId: string, needles: readonly string[]) {
  const db = drizzle(postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }), {
    schema,
  });
  return peopleByNameQuery(db, orgId, needles).toSQL();
}

describe("resolving an attendee name never reaches outside the tenant or past a revoked membership", () => {
  const compiled = compile("org-attacker", ["jordan lee"]);
  const lowered = compiled.sql.toLowerCase();

  it("binds the org id as a parameter rather than a literal", () => {
    expect(compiled.params).toContain("org-attacker");
    expect(compiled.sql).not.toContain("org-attacker");
  });

  it("joins organization_members on ACTIVE, so an offboarded person is never offered as an attendee the calendar will then reject", () => {
    expect(lowered).toContain('"organization_members"');
    expect(lowered).toContain("inner join");
    expect(compiled.params).toContain("ACTIVE");
  });

  it("re-asserts the org on both sides of the join, so a foreign membership row cannot carry a foreign person in", () => {
    expect(lowered).toMatch(
      /"organization_members"\."org_id" = "organization_people"\."organization_id"|"organization_people"\."organization_id" = "organization_members"\."org_id"/,
    );
  });

  it("excludes soft-deleted people, because a deleted_at column reads ignore resurrects deleted rows", () => {
    expect(lowered).toContain('"organization_people"."deleted_at" is null');
  });

  it("joins users on isActive and a null deleted_at, because an ACTIVE membership row outlives a deactivated global user", () => {
    expect(lowered).toContain('"users"."is_active"');
    expect(lowered).toContain('"users"."deleted_at" is null');
  });

  it("offers a partial match as well as an exact one, so a model passing a first name still finds the person", () => {
    expect(compiled.params).toContain("%jordan lee%");
  });

  it("escapes a wildcard in the name, so a person called '%' cannot match the whole organization", () => {
    expect(compile("org-1", ["%"]).params).not.toContain("%%%");
  });

  it("bounds the read, so a name matching everybody cannot pull the organization into memory", () => {
    expect(lowered).toContain("limit");
    expect(compiled.params).toContain(
      NAME_RESOLUTION_MAX_NAMES * (NAME_RESOLUTION_MAX_CANDIDATES + 1),
    );
  });
});

describe("a batch name resolution answers for every name it was given", () => {
  function dbReturning(rows: readonly Record<string, unknown>[]): Db {
    const query = Promise.resolve(rows);
    const chain = {
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      limit: () => query,
    };
    return chain as unknown as Db;
  }

  it("issues no query at all for an empty name list, rather than a match-nothing round trip", async () => {
    const select = jest.fn();
    const resolved = await resolvePeopleByName({ select } as unknown as Db, "org-1", []);

    expect(select).not.toHaveBeenCalled();
    expect(resolved.size).toBe(0);
  });

  it("reports a name with no row as unresolved instead of dropping it, so the caller can say which name failed", async () => {
    const resolved = await resolvePeopleByName(dbReturning([]), "org-1", ["Jordan Lee"]);

    expect(resolved.get("Jordan Lee")).toEqual({ status: "unresolved" });
  });

  it("reports two rows under one name as ambiguous rather than silently picking the first", async () => {
    const resolved = await resolvePeopleByName(
      dbReturning([
        {
          userId: "u-1",
          displayName: "Jordan Lee",
          firstName: "Jordan",
          lastName: "Lee",
          workEmail: "a@example.com",
          displayKey: "jordan lee",
          fullNameKey: "jordan lee",
        },
        {
          userId: "u-2",
          displayName: "Jordan Lee",
          firstName: "Jordan",
          lastName: "Lee",
          workEmail: "b@example.com",
          displayKey: "jordan lee",
          fullNameKey: "jordan lee",
        },
      ]),
      "org-1",
      ["Jordan Lee"],
    );

    expect(resolved.get("Jordan Lee")).toEqual({
      status: "ambiguous",
      candidates: [
        { label: "Jordan Lee", hint: "a@example.com" },
        { label: "Jordan Lee", hint: "b@example.com" },
      ],
    });
  });

  it("matches case-insensitively and hands back the caller's original spelling as the key", async () => {
    const resolved = await resolvePeopleByName(
      dbReturning([
        {
          userId: "u-1",
          displayName: "Jordan Lee",
          firstName: "Jordan",
          lastName: "Lee",
          workEmail: null,
          displayKey: "jordan lee",
          fullNameKey: "jordan lee",
        },
      ]),
      "org-1",
      ["  JORDAN lee  "],
    );

    expect(resolved.get("JORDAN lee")).toEqual({ status: "resolved", userId: "u-1", displayName: "Jordan Lee" });
  });

  it("resolves a first name to the one person it partially matches, which is how a model actually refers to people", async () => {
    const resolved = await resolvePeopleByName(
      dbReturning([
        {
          userId: "u-1",
          displayName: "Jordan Lee",
          firstName: "Jordan",
          lastName: "Lee",
          workEmail: null,
          displayKey: "jordan lee",
          fullNameKey: "jordan lee",
        },
      ]),
      "org-1",
      ["jordan"],
    );

    expect(resolved.get("jordan")).toEqual({ status: "resolved", userId: "u-1", displayName: "Jordan Lee" });
  });

  it("prefers the exact match over the people who merely contain it, so 'Sam' resolves to Sam rather than going ambiguous against Samantha", async () => {
    const resolved = await resolvePeopleByName(
      dbReturning([
        {
          userId: "u-1",
          displayName: "Sam",
          firstName: "Sam",
          lastName: "",
          workEmail: null,
          displayKey: "sam",
          fullNameKey: "sam",
        },
        {
          userId: "u-2",
          displayName: "Samantha Price",
          firstName: "Samantha",
          lastName: "Price",
          workEmail: null,
          displayKey: "samantha price",
          fullNameKey: "samantha price",
        },
      ]),
      "org-1",
      ["Sam"],
    );

    expect(resolved.get("Sam")).toEqual({ status: "resolved", userId: "u-1", displayName: "Sam" });
  });

  it("caps the names it will look up, so a model emitting hundreds of attendees cannot widen the statement without bound", async () => {
    const names = Array.from({ length: NAME_RESOLUTION_MAX_NAMES + 5 }, (_, i) => `Person ${String(i)}`);
    const resolved = await resolvePeopleByName(dbReturning([]), "org-1", names);

    expect(resolved.size).toBe(NAME_RESOLUTION_MAX_NAMES);
  });
});

describe("a member the HR and directory paths never touched is still resolvable", () => {
  const compiled = compile("org-1", ["asha"]);
  const lowered = compiled.sql.toLowerCase();

  it("drives the search from organization_members, because an organization_people row is created only by the directory, HR, import, recruitment and seed paths", () => {
    expect(lowered).toMatch(/from\s+"organization_members"/);
  });

  it("reaches organization_people through a left join, so a member without one is a candidate rather than invisible", () => {
    expect(lowered).toContain('left join "organization_people"');
  });

  it("still inner joins users, so the left join above cannot smuggle in a deactivated account", () => {
    expect(lowered).toContain('inner join "users"');
  });

  it("ladders the display key down to the user record, so a person row that never existed does not blank the name it matches on", () => {
    expect(lowered).toContain('"users"."name"');
  });
});

describe("a person is resolvable by their email address, not only by their name", () => {
  function dbReturning(rows: readonly Record<string, unknown>[]): Db {
    const query = Promise.resolve(rows);
    const chain = {
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      limit: () => query,
    };
    return chain as unknown as Db;
  }

  const BOB = {
    userId: "user-bob",
    displayName: "Bob Kaur",
    firstName: "Bob",
    lastName: "Kaur",
    workEmail: "bob@acme.test",
    displayKey: "bob kaur",
    fullNameKey: "bob kaur",
    emailKey: "bob@acme.test",
  };

  it("resolves an exact email address, because asking Ask OS to find bob@acme.test used to return nobody", async () => {
    const resolved = await resolvePeopleByName(dbReturning([BOB]), "org-1", ["bob@acme.test"]);

    expect(resolved.get("bob@acme.test")).toEqual({
      status: "resolved",
      userId: "user-bob",
      displayName: "Bob Kaur",
      email: "bob@acme.test",
    });
  });

  it("matches an email case-insensitively, because a pasted address often carries the sender's capitalisation", async () => {
    const resolved = await resolvePeopleByName(dbReturning([BOB]), "org-1", ["Bob@Acme.test"]);

    expect(resolved.get("Bob@Acme.test")).toMatchObject({ status: "resolved", userId: "user-bob" });
  });

  it("never partial-matches an email, because a needle like \"acme.test\" would otherwise resolve the whole company", async () => {
    const resolved = await resolvePeopleByName(dbReturning([BOB]), "org-1", ["acme.test"]);

    expect(resolved.get("acme.test")).toEqual({ status: "unresolved" });
  });

  it("carries the email on a name-resolved person too, so a caller does not need a second lookup to address them", async () => {
    const resolved = await resolvePeopleByName(dbReturning([BOB]), "org-1", ["Bob Kaur"]);

    expect(resolved.get("Bob Kaur")).toMatchObject({ email: "bob@acme.test" });
  });

  it("omits email entirely when the person has none, rather than emitting an empty string a caller would send mail to", async () => {
    const resolved = await resolvePeopleByName(
      dbReturning([{ ...BOB, workEmail: null, emailKey: "" }]),
      "org-1",
      ["Bob Kaur"],
    );

    expect(resolved.get("Bob Kaur")).not.toHaveProperty("email");
  });

  it("prefers an exact email hit over a partial name hit, so an address never loses to a substring", async () => {
    const bobby = { ...BOB, userId: "user-bobby", displayName: "Bobby Singh", displayKey: "bobby singh", fullNameKey: "bobby singh", emailKey: "bobby@acme.test" };
    const resolved = await resolvePeopleByName(dbReturning([BOB, bobby]), "org-1", ["bob@acme.test"]);

    expect(resolved.get("bob@acme.test")).toMatchObject({ status: "resolved", userId: "user-bob" });
  });
});
