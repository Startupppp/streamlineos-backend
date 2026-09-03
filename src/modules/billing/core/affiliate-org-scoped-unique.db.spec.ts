/**
 * The regression net for the P1 in `AffiliateService.register`.
 *
 * `affiliates_user_id_unique` was UNIQUE(user_id) with no org_id — a bare global unique on
 * a tenant-owned table, from `.unique()` on the column in db/schema/billing/billing.ts and
 * created by migrations/0000_light_vance_astro.sql:9899. `register()` pre-checked a
 * DIFFERENT key, (org_id, user_membership_id). A user already an affiliate in org A who
 * joins org B therefore passed the pre-check, hit the global constraint on the insert,
 * and — with nothing catching 23505 — got a 500 with no diagnostic. A person could be an
 * affiliate in exactly one organisation in the entire deployment.
 *
 * Migration 1055 replaces it with uniq_affiliates_org_user (org_id, user_id), which is
 * backend/CLAUDE.md §3's rule verbatim: tenant-scoped uniqueness is composite.
 *
 * The CATALOG half is the one that matters and cannot be mocked: which columns a unique
 * constraint actually covers is a fact about Postgres, and a fake db answers whatever it
 * was told. It runs the two-organisation insert for real and rolls it back.
 *
 *   BILLING_DB_TESTS=1 DATABASE_URL=postgresql://… \
 *     npx jest --runInBand --testPathPattern="affiliate-org-scoped-unique"
 */
import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
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
    // The membership id is what it used to key on, and the reason the guard missed.
    expect(values).not.toContain(MEMBERSHIP);
  });

  it("an existing affiliate in this org is still a 409", async () => {
    const { db } = makeDb({ existing: { id: 1 } });
    await expect(new AffiliateService(db).register(USER, ORG, MEMBERSHIP)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("a 23505 that races past the pre-check becomes a 409, not an unhandled 500", async () => {
    // Shaped as drizzle wraps it: the SQLSTATE lives on `.cause`, never on the outer error.
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

class Rollback extends Error {}

const ENABLED = process.env.BILLING_DB_TESTS === "1";
const DB_URL = process.env.BILLING_PROBE_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

describeDb("affiliates — real catalog", () => {
  let client: postgres.Sql;

  beforeAll(() => {
    client = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("the deployment-global UNIQUE(user_id) is gone", async () => {
    const rows = await client<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'affiliates'::regclass AND conname = 'affiliates_user_id_unique'`;
    expect(rows).toHaveLength(0);
  });

  it("uniqueness is (org_id, user_id) in the catalog, not just in the declaration", async () => {
    const [row] = await client<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'affiliates'::regclass AND conname = 'uniq_affiliates_org_user'`;
    expect(row?.def).toBe("UNIQUE (org_id, user_id)");
  });

  it("one person can be an affiliate in two organisations, and still not twice in one", async () => {
    const tag = randomUUID().slice(0, 8);
    const userId = `p1probe-${tag}`;
    const orgA = `p1probe-a-${tag}`;
    const orgB = `p1probe-b-${tag}`;

    const observed = await client
      .begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@example.test`})`;
      for (const [org, name] of [[orgA, "A"], [orgB, "B"]] as const) {
        await tx`
          INSERT INTO organizations (id, name, slug, owner_membership_id)
          SELECT ${org}, ${name}, ${org}, max(id) + 1 FROM organization_members`;
      }
      const members: Record<string, number> = {};
      for (const org of [orgA, orgB]) {
        const [member] = await tx<Array<{ id: number }>>`
          INSERT INTO organization_members (org_id, user_id, role, status, is_owner)
          VALUES (${org}, ${userId}, 'OWNER', 'ACTIVE', true) RETURNING id`;
        members[org] = member.id;
        await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${org}`;
      }

      const insertAffiliate = (org: string, code: string) => tx`
        INSERT INTO affiliates (user_id, org_id, referral_code, user_membership_id)
        VALUES (${userId}, ${org}, ${code}, ${members[org]})`;

      await insertAffiliate(orgA, `PA${tag.toUpperCase()}`);
      // The insert that raised 23505 on affiliates_user_id_unique at journal head.
      await insertAffiliate(orgB, `PB${tag.toUpperCase()}`);

      // A savepoint, because an error aborts the enclosing transaction outright and the
      // row count below still has to be readable afterwards.
      let secondInSameOrg = "allowed";
      try {
        await tx.savepoint(async (sp) => {
          await sp`
            INSERT INTO affiliates (user_id, org_id, referral_code, user_membership_id)
            VALUES (${userId}, ${orgB}, ${`PC${tag.toUpperCase()}`}, ${members[orgB]})`;
        });
      } catch (error: unknown) {
        secondInSameOrg = String((error as { constraint_name?: string }).constraint_name);
      }

      const rows = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM affiliates WHERE user_id = ${userId}`;
      // Roll the whole fixture back rather than deleting it: a failed assertion above must
      // leave the database exactly as it was found, and `client.begin` otherwise commits.
      throw Object.assign(new Rollback(), {
        result: { affiliateRows: rows[0].n, secondInSameOrg },
      });
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (error instanceof Rollback) {
          return (error as Rollback & { result: Record<string, unknown> }).result;
        }
        throw error;
      });

    expect(observed).toEqual({ affiliateRows: 2, secondInSameOrg: "uniq_affiliates_org_user" });
  }, 30_000);

  it("leaves nothing behind", async () => {
    const [row] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM affiliates WHERE user_id LIKE 'p1probe-%'`;
    expect(row?.n).toBe(0);
  });
});
