import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALL_ANALYSIS_PERMISSIONS,
  CALL_ANALYSIS_VIEW_OWN,
  CALL_ANALYSIS_VIEW_TEAM,
} from "../permissions";

/**
 * The backfill reaches somebody, and it reaches the same keys the routes ask for.
 *
 * Seven migrations in this series granted to `CRM_ADMIN` — a `ROLE_TEMPLATES`
 * slug the seeder never mints — and so granted eighteen permissions to nobody,
 * silently, because `ON CONFLICT DO NOTHING` over an empty result set is a clean
 * migration. `rbac/__tests__/backfill-slugs-exist.spec.ts` now refuses that
 * shape across every migration in the repository, and this file adds the half
 * that check cannot make: that the keys THIS module's routes require are the
 * keys THIS migration grants. A decorator and a backfill that disagree by one
 * character is a permanent 403 for every organisation that already existed.
 */

const MIGRATION = readFileSync(
  join(__dirname, "../../../../migrations/0533_call_analysis.sql"),
  "utf8",
);

/**
 * Comments explain slugs; only executable SQL grants to them.
 *
 * `--> statement-breakpoint` is spared, and that is not cosmetic — it is a `--`
 * comment to Postgres and the statement separator to drizzle, so stripping it
 * with the rest fuses every statement in the file into one string and any test
 * that looks for "the grant that names this key" silently matches all of them.
 */
const executable = MIGRATION.split("\n")
  .map((line) => (line.startsWith("--> ") ? line : line.replace(/--.*$/, "")))
  .join("\n");

describe("migration 0533 backfills the call-analysis permissions", () => {
  it("creates both permissions before granting them", () => {
    for (const key of CALL_ANALYSIS_PERMISSIONS) {
      expect(executable).toContain(`'${key}'`);
      expect(executable).toMatch(
        new RegExp(`INSERT INTO "permissions"[\\s\\S]*'${key}'`, "m"),
      );
    }
  });

  it("names only slugs the seeder actually mints", () => {
    /**
     * The same predicate `backfill-slugs-exist.spec.ts` applies repository-wide,
     * restated here so this migration fails on its own terms rather than in a
     * suite somebody might read as unrelated.
     */
    const seededShape = (slug: string): boolean =>
      /^[A-Z0-9]+_MODULE_(OWNER|ADMIN|MEMBER)$/.test(slug) ||
      ["OWNER", "ORG_ADMIN", "MEMBER"].includes(slug);

    const slugs = [
      ...executable.matchAll(/"?slug"?\s*(?:=|IN)\s*(\([^)]*\)|'[A-Z0-9_]+')/gi),
    ].flatMap((match) => [...match[1]!.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!));

    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(seededShape(slug)).toBe(true);
  });

  it("gives a member their own calls and does not give them the team", () => {
    /**
     * The split is the ticket. A member handed the team surface is reading a
     * pooled view of colleagues, and a member denied their own is being coached
     * from a screen they cannot open.
     */
    const ownGrant = grantBlockFor(CALL_ANALYSIS_VIEW_OWN);
    const teamGrant = grantBlockFor(CALL_ANALYSIS_VIEW_TEAM);

    expect(ownGrant).toContain("CRM_MODULE_MEMBER");
    expect(teamGrant).not.toContain("CRM_MODULE_MEMBER");
    for (const slug of ["CRM_MODULE_OWNER", "CRM_MODULE_ADMIN"]) {
      expect(ownGrant).toContain(slug);
      expect(teamGrant).toContain(slug);
    }
  });

  it("bumps the access version, or the grant reads as a 403 until sessions expire", () => {
    expect(executable).toContain('INSERT INTO "access_versions"');
    expect(executable).toContain('"permissions_version" = "access_versions"."permissions_version" + 1');
  });
});

describe("the routes and the backfill agree", () => {
  const readDir = join(__dirname, "../read");

  it("requires exactly the permissions this migration grants", () => {
    const decorated = readdirSync(readDir)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => [
        ...readFileSync(join(readDir, file), "utf8").matchAll(
          /@RequirePermission\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
        ),
      ])
      .map((match) => match[1]!);

    // Named constants rather than string literals, so the decorator and the
    // migration cannot drift by a typo nobody notices until a tenant reports a 403.
    expect([...new Set(decorated)].sort()).toEqual([
      "CALL_ANALYSIS_VIEW_OWN",
      "CALL_ANALYSIS_VIEW_TEAM",
    ]);
  });

  it("has a grant for every key a route requires", () => {
    for (const key of CALL_ANALYSIS_PERMISSIONS)
      expect(grantBlockFor(key)).toContain("role_permission_grants");
  });
});

/** The statement that grants one key, from the INSERT down to its ON CONFLICT. */
function grantBlockFor(key: string): string {
  const block = executable
    .split("--> statement-breakpoint")
    .find(
      (statement) =>
        statement.includes('INSERT INTO "role_permission_grants"') && statement.includes(`'${key}'`),
    );

  if (!block) throw new Error(`0533 has no grant statement for ${key}`);
  return block;
}
