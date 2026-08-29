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

const EXPECTED_EXEMPTIONS = [
  "public.organization_placement",
  "public.organization_lifecycle_sagas",
  "public.organization_saga_steps",
  "public.organization_reservations",
  "public.organization_relocations",
  "public.organization_relocation_checksums",
  "public.placement_decisions",
  "public.noisy_neighbour_reviews",
];

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

  it("every exemption is a control-plane or cross-tenant-uniqueness table", () => {
    // A tenant business table must never appear here — it would silence its own hole.
    for (const table of actual) {
      expect(table.startsWith("public.organization_") || table.startsWith("public.placement_") || table.startsWith("public.noisy_neighbour_")).toBe(true);
    }
  });

  it("detects an added exemption", () => {
    const tampered = [...EXPECTED_EXEMPTIONS, "public.hr_employees"];
    expect([...tampered].sort()).not.toEqual([...EXPECTED_EXEMPTIONS].sort());
    expect(tampered.some((t) => !t.startsWith("public.organization_") && !t.startsWith("public.placement_") && !t.startsWith("public.noisy_neighbour_"))).toBe(true);
  });
});
