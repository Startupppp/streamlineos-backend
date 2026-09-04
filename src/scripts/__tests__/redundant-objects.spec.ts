/**
 * Regression cover for PRD-C059's detector.
 *
 * Three defects are pinned here, each one measured at journal head before it was
 * written:
 *
 *   1. Comparing `indkey` without `indoption` reports a DESC-trailing index as an
 *      exact duplicate of its ASC sibling. All three pairs the ticket-02 triage
 *      called duplicates are this shape, and "ordering" is the first thing
 *      PRD-C059 says to preserve.
 *   2. A leading-prefix pair is an overlap, not a redundancy. Migration 0999
 *      dropped 337 narrow indexes on the opposite assumption and seven of them
 *      were measured regressions under tenant skew.
 *   3. Statistics alone must never justify a deletion. Every verdict must be
 *      identical when the scan counts are replaced by extremes.
 */

import {
  detectConstraintDuplicates,
  detectForeignKeySubsumption,
  detectIndexOverlaps,
  detectUniqueSubsumption,
  preserved,
  redundant,
  statisticsAreInert,
} from "../redundant-objects/detect";
import {
  constraint,
  DESC_TRAILING_PAIR,
  DUPLICATE_FKS,
  index,
  ORDERING_ERASED_PAIR,
  TENANT_PREFIX_PAIR,
} from "../redundant-objects/self-test";

describe("redundant-object detection", () => {
  it("does not call a DESC-trailing index a duplicate of its ASC sibling", () => {
    expect(detectIndexOverlaps(DESC_TRAILING_PAIR)).toEqual([]);
  });

  it("still detects the same pair once the ordering is erased, so the control is not vacuous", () => {
    const found = detectIndexOverlaps(ORDERING_ERASED_PAIR);
    expect(found).toHaveLength(1);
    expect(found[0]?.verdict).toBe("REDUNDANT");
    expect(found[0]?.candidate).toBe("idx_crm_commission_plan_versions_lookup");
    expect(found[0]?.survivor).toBe("uniq_crm_commission_plan_versions_effective");
  });

  it("never proposes dropping a UNIQUE in favour of a non-unique", () => {
    const found = detectIndexOverlaps([
      index({ tbl: "t", name: "idx_plain", keydef: "org_id:0,code:0" }),
      index({ tbl: "t", name: "uniq_code", keydef: "org_id:0,code:0", is_unique: true, backs_constraint: true }),
    ]);
    expect(found[0]?.candidate).toBe("idx_plain");
    expect(found[0]?.survivor).toBe("uniq_code");
  });

  it("never proposes dropping a constraint-backing index or a primary key", () => {
    const both = detectIndexOverlaps([
      index({ tbl: "t", name: "idx_a", keydef: "org_id:0,status:0", backs_constraint: true }),
      index({ tbl: "t", name: "idx_b", keydef: "org_id:0,status:0", is_primary: true }),
    ]);
    expect(redundant(both)).toEqual([]);
    expect(preserved(both)).toHaveLength(1);
  });

  it("reports a leading-prefix pair and always preserves it", () => {
    const found = detectIndexOverlaps(TENANT_PREFIX_PAIR);
    expect(found).toHaveLength(1);
    expect(found[0]?.verdict).toBe("PRESERVE");
    expect(found[0]?.preserveReason).toBe("documented-access-pattern");
  });

  it("does not treat a partial index as subsumed by a wider unfiltered one", () => {
    expect(
      detectIndexOverlaps([
        index({ tbl: "t", name: "idx_live", keydef: "org_id:0", predicate: "(deleted_at IS NULL)" }),
        index({ tbl: "t", name: "idx_all", keydef: "org_id:0,status:0" }),
      ]),
    ).toEqual([]);
  });

  it("flags two identical plain indexes as redundant", () => {
    const found = redundant(
      detectIndexOverlaps([
        index({ tbl: "t", name: "idx_a", keydef: "org_id:0,status:0" }),
        index({ tbl: "t", name: "idx_b", keydef: "org_id:0,status:0" }),
      ]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.candidate).toBe("idx_a");
  });

  it("flags a duplicate foreign key and keeps the lexicographically first name", () => {
    const found = redundant(detectConstraintDuplicates(DUPLICATE_FKS));
    expect(found).toHaveLength(1);
    expect(found[0]?.survivor).toBe("fin_reimbursement_batches_approved_by_fkey");
    expect(detectConstraintDuplicates(DUPLICATE_FKS.slice(0, 1))).toEqual([]);
  });

  it("flags a duplicate unique constraint and a duplicate check", () => {
    const duplicates = detectConstraintDuplicates([
      constraint({ tbl: "t", name: "uniq_a", kind: "u", signature: "{2,3}" }),
      constraint({ tbl: "t", name: "uniq_b", kind: "u", signature: "{2,3}" }),
      constraint({ tbl: "t", name: "chk_a", kind: "c", signature: "CHECK ((amount >= 0))" }),
      constraint({ tbl: "t", name: "chk_b", kind: "c", signature: "CHECK ((amount >= 0))" }),
    ]);
    expect(redundant(duplicates).map((entry) => entry.kind).sort()).toEqual(["check", "unique"]);
  });

  it("moves no verdict when the workload statistics change", () => {
    const hot = TENANT_PREFIX_PAIR.map((entry) => ({ ...entry, idx_scan: 5_000_000, n_live_tup: 9_000_000 }));
    const cold = TENANT_PREFIX_PAIR.map((entry) => ({ ...entry, idx_scan: 0, n_live_tup: 0 }));
    expect(detectIndexOverlaps(hot).map((entry) => [entry.id, entry.verdict])).toEqual(
      detectIndexOverlaps(cold).map((entry) => [entry.id, entry.verdict]),
    );
    expect(statisticsAreInert([...TENANT_PREFIX_PAIR, ...DESC_TRAILING_PAIR], DUPLICATE_FKS)).toBe(true);
  });

  it("keeps the tenant-anchored (org_id, id) unique that the primary key logically implies", () => {
    const found = detectUniqueSubsumption([
      index({ tbl: "hr_people", name: "hr_people_pkey", keydef: "id:0", is_unique: true, is_primary: true, backs_constraint: true }),
      index({
        tbl: "hr_people",
        name: "uniq_hr_people_org_id",
        keydef: "org_id:0,id:0",
        is_unique: true,
        backs_constraint: true,
        leads_with_tenant: true,
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.candidate).toBe("uniq_hr_people_org_id");
    expect(found[0]?.verdict).toBe("PRESERVE");
    expect(found[0]?.preserveReason).toBe("tenant-anchored-fk-target");
    expect(redundant(found)).toEqual([]);
  });

  it("prefers the live foreign-key-target reason over the tenant one when both hold", () => {
    const found = detectUniqueSubsumption([
      index({ tbl: "projects", name: "projects_pkey", keydef: "id:0", is_unique: true, is_primary: true, backs_constraint: true }),
      index({
        tbl: "projects",
        name: "uniq_projects_org_id",
        keydef: "org_id:0,id:0",
        is_unique: true,
        backs_constraint: true,
        leads_with_tenant: true,
        is_fk_target: true,
      }),
    ]);
    expect(found[0]?.preserveReason).toBe("referenced-by-a-foreign-key");
  });

  it("keeps a single-column foreign key that a composite to the same parent implies", () => {
    const found = detectForeignKeySubsumption([
      constraint({
        tbl: "tickets",
        name: "tickets_project_id_fkey",
        kind: "f",
        signature: "s1",
        colset: "{4}",
        parent: "build.projects",
        actions: "aa",
        definition: "FOREIGN KEY (project_id) REFERENCES build.projects(id)",
      }),
      constraint({
        tbl: "tickets",
        name: "fk_tickets_org_project",
        kind: "f",
        signature: "s2",
        colset: "{2,4}",
        parent: "build.projects",
        actions: "ac",
        definition: "FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) ON DELETE CASCADE",
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.candidate).toBe("tickets_project_id_fkey");
    expect(found[0]?.verdict).toBe("PRESERVE");
    expect(found[0]?.preserveReason).toBe("distinct-referential-action");
    expect(redundant(found)).toEqual([]);
  });

  it("does not call two foreign keys to DIFFERENT parents an overlap", () => {
    expect(
      detectForeignKeySubsumption([
        constraint({ tbl: "t", name: "a", kind: "f", signature: "s1", colset: "{4}", parent: "public.users", actions: "aa" }),
        constraint({ tbl: "t", name: "b", kind: "f", signature: "s2", colset: "{2,4}", parent: "public.orgs", actions: "aa" }),
      ]),
    ).toEqual([]);
  });

  it("never reports a never-scanned index that duplicates nothing", () => {
    expect(detectIndexOverlaps([index({ tbl: "t", name: "idx_lonely", keydef: "org_id:0,kind:0", idx_scan: 0 })])).toEqual([]);
  });
});
