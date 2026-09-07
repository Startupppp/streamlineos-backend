import { ConflictException } from "@nestjs/common";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { affiliates } from "../../../db/schema";
import { AffiliateService } from "./affiliate.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

describe("affiliates — the declaration no longer carries a deployment-global unique", () => {
  it("user_id is not unique on its own", () => {
    const column = getTableConfig(affiliates).columns.find((c) => c.name === "user_id");
    expect(column).toBeDefined();
    expect(column?.isUnique).toBe(false);
  });

  it("uniqueness is declared composite, leading with org_id", () => {
    const names = getTableConfig(affiliates).uniqueConstraints.map((u) => u.name);
    expect(names).toContain("uniq_affiliates_org_user");
    const orgUser = getTableConfig(affiliates).uniqueConstraints.find(
      (u) => u.name === "uniq_affiliates_org_user",
    );
    expect(orgUser?.columns.map((c) => c.name)).toEqual(["org_id", "user_id"]);
  });
});

describe("AffiliateService.register guards the key the database enforces", () => {
  const USER = "user-a";
  const ORG = "org-a";
  const MEMBERSHIP = 42;

  function makeDb(options: { existing?: unknown; insertError?: unknown }) {
    const affiliateWhere = jest
      .fn()
      .mockResolvedValue(options.existing ? [options.existing] : []);
    let call = 0;
    const select = jest.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return {
          from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: MEMBERSHIP }]) }) }),
        };
      }
      return { from: () => ({ where: affiliateWhere }) };
    });
    const insert = jest.fn().mockReturnValue({
      values: () => ({
        returning: () =>
          options.insertError
            ? Promise.reject(options.insertError)
            : Promise.resolve([{ id: 1, userId: USER, orgId: ORG }]),
      }),
    });
    return { db: { select, insert } as unknown as Db, affiliateWhere };
  }

  it("pre-checks (org_id, user_id), not (org_id, user_membership_id)", async () => {
    const { db, affiliateWhere } = makeDb({});
    await new AffiliateService(db).register(USER, ORG, MEMBERSHIP);

    const values = sqlValues(affiliateWhere.mock.calls[0]?.[0]);
    expect(values).toContain(ORG);
    expect(values).toContain(USER);
    expect(values).not.toContain(MEMBERSHIP);
  });

  it("an existing affiliate in this org is still a 409", async () => {
    const { db } = makeDb({ existing: { id: 1 } });
    await expect(new AffiliateService(db).register(USER, ORG, MEMBERSHIP)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("a 23505 that races past the pre-check becomes a 409, not an unhandled 500", async () => {
    const wrapped = Object.assign(new Error("Failed query: insert into affiliates"), {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "uniq_affiliates_org_user",
      }),
    });
    const { db } = makeDb({ insertError: wrapped });

    await expect(new AffiliateService(db).register(USER, ORG, MEMBERSHIP)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("an unrelated failure is still raised, not swallowed as a conflict", async () => {
    const { db } = makeDb({ insertError: new Error("connection reset") });
    await expect(new AffiliateService(db).register(USER, ORG, MEMBERSHIP)).rejects.toThrow(
      "connection reset",
    );
  });
});
