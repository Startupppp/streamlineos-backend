import { readFileSync } from "fs";
import { join } from "path";

/**
 * `db:verify-rls` fails on any tenant table with no RLS policy — unless the table is listed in
 * `PLATFORM_GLOBAL_TABLES`, which suppresses the failure. That list is therefore the one lever
 * that can silence a genuine cross-tenant hole, and nothing else guards it. This pins it.
 *
 * Session 6 found three tables (`inv_carton_types`, `inv_shipment_status_events`,
 * `organization_cell_traffic`) live with a NOT NULL org_id, full app-role grants and no policy.
 * Migration 0650 gave them policies. Adding them to this list instead would also have turned the
 * verifier green, and nothing would have noticed.
 */

const VERIFIER = join(__dirname, "..", "..", "src", "scripts", "db-verify-rls.mjs");

const CONTROL_PLANE_EXEMPTIONS = [
  "public.organization_placement",
  "public.organization_lifecycle_sagas",
  "public.organization_saga_steps",
  "public.organization_reservations",
  "public.organization_relocations",
  "public.organization_relocation_checksums",
  "public.placement_decisions",
  "public.noisy_neighbour_reviews",
];

const PRE_AUTHENTICATION_EXEMPTIONS = ["public.magic_link_tokens", "public.impersonation_sessions"];

const EXPECTED_EXEMPTIONS = [...CONTROL_PLANE_EXEMPTIONS, ...PRE_AUTHENTICATION_EXEMPTIONS];

function isControlPlane(table: string): boolean {
  return (
    table.startsWith("public.organization_") ||
    table.startsWith("public.placement_") ||
    table.startsWith("public.noisy_neighbour_")
  );
}

function parseExemptions(source: string): string[] {
  const start = source.indexOf("const PLATFORM_GLOBAL_TABLES = new Set([");
  if (start === -1) return [];
  const end = source.indexOf("]);", start);
  if (end === -1) return [];
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((match) => match[1] ?? "");
}

describe("RLS exemption allowlist", () => {
  const source = readFileSync(VERIFIER, "utf8");
  const actual = parseExemptions(source);

  it("parses the allowlist out of the verifier", () => {
    // Anti-vacuity: a parser that returns nothing would make every assertion below pass.
    expect(actual.length).toBeGreaterThan(5);
  });

  it("exempts exactly the control-plane tables, and nothing else", () => {
    expect([...actual].sort()).toEqual([...EXPECTED_EXEMPTIONS].sort());
  });

  it("every exemption is either a control-plane table or one of the two named pre-authentication tables, so a tenant business table cannot silence its own hole", () => {
    for (const table of actual) {
      expect(isControlPlane(table) || PRE_AUTHENTICATION_EXEMPTIONS.includes(table)).toBe(true);
    }
  });

  it("the pre-authentication class is a closed list of two, not a prefix rule, because a prefix would admit any future auth table without review", () => {
    expect(PRE_AUTHENTICATION_EXEMPTIONS).toHaveLength(2);
    for (const table of PRE_AUTHENTICATION_EXEMPTIONS) {
      expect(isControlPlane(table)).toBe(false);
    }
  });

  it("magic_link_tokens and impersonation_sessions are exempt because their only readers run before a tenant GUC exists: verifyMagicLink is the authentication itself, and impersonation is read in jwt-auth.guard.ts, which BE-73 states has no GUC", () => {
    for (const table of PRE_AUTHENTICATION_EXEMPTIONS) {
      expect(actual).toContain(table);
    }
  });

  it("detects an added exemption", () => {
    const tampered = [...EXPECTED_EXEMPTIONS, "public.hr_employees"];
    expect([...tampered].sort()).not.toEqual([...EXPECTED_EXEMPTIONS].sort());
    expect(
      tampered.some((t) => !isControlPlane(t) && !PRE_AUTHENTICATION_EXEMPTIONS.includes(t)),
    ).toBe(true);
  });
});
