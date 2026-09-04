/**
 * `--self-test`. A detector that has never fired is not a detector. Every
 * assertion below drives the pure half from fixtures, and each control is
 * asserted in BOTH directions: the finding fires with its cause present and
 * stops with the cause removed.
 *
 * The fixtures are the real shapes measured at journal head, not inventions:
 * `crm_commission_plan_versions` for the DESC-trailing pair a naive `indkey`
 * comparison calls a duplicate, and the tenant-leading prefix pair migration
 * 0999 dropped 337 of.
 */

import type { LiveConstraint, LiveIndex } from "./catalog";
import { detectConstraintDuplicates, detectIndexOverlaps, preserved, redundant, statisticsAreInert } from "./detect";

export function index(over: Partial<LiveIndex> & Pick<LiveIndex, "tbl" | "name" | "keydef">): LiveIndex {
  return {
    schema: "public",
    am: "btree",
    is_unique: false,
    is_primary: false,
    backs_constraint: false,
    predicate: "",
    includedef: "",
    idx_scan: 0,
    n_live_tup: 0,
    is_fk_target: false,
    leads_with_tenant: false,
    ...over,
  };
}

export function constraint(
  over: Partial<LiveConstraint> & Pick<LiveConstraint, "tbl" | "name" | "kind" | "signature">,
): LiveConstraint {
  return { schema: "public", definition: "", colset: "", parent: "", actions: "", ...over };
}

/** The pair the triage called an exact duplicate. It is not one. */
export const DESC_TRAILING_PAIR: readonly LiveIndex[] = [
  index({
    tbl: "crm_commission_plan_versions",
    name: "uniq_crm_commission_plan_versions_effective",
    keydef: "org_id:0,plan_id:0,effective_from:0",
    is_unique: true,
  }),
  index({
    tbl: "crm_commission_plan_versions",
    name: "idx_crm_commission_plan_versions_lookup",
    keydef: "org_id:0,plan_id:0,effective_from:3",
  }),
];

/** The same pair with the ordering flattened away — what an `indkey` comparison sees. */
export const ORDERING_ERASED_PAIR: readonly LiveIndex[] = DESC_TRAILING_PAIR.map((entry) => ({
  ...entry,
  keydef: entry.keydef.replace(/:3/g, ":0"),
}));

export const TENANT_PREFIX_PAIR: readonly LiveIndex[] = [
  index({ tbl: "inv_stock_levels", name: "idx_inv_stock_levels_org", keydef: "org_id:0", idx_scan: 0 }),
  index({ tbl: "inv_stock_levels", name: "idx_inv_stock_levels_org_variant", keydef: "org_id:0,variant_id:0", idx_scan: 900_000 }),
];

export const DUPLICATE_FKS: readonly LiveConstraint[] = [
  constraint({
    tbl: "fin_reimbursement_batches",
    name: "fin_reimbursement_batches_approved_by_fkey",
    kind: "f",
    signature: "{7}->16384{1} aa",
    definition: "FOREIGN KEY (approved_by) REFERENCES users(id)",
  }),
  constraint({
    tbl: "fin_reimbursement_batches",
    name: "fin_reimbursement_batches_approved_by_users_id_fk",
    kind: "f",
    signature: "{7}->16384{1} aa",
    definition: "FOREIGN KEY (approved_by) REFERENCES users(id)",
  }),
];

export function runSelfTest(): never {
  const failures: string[] = [];
  let passed = 0;
  const assert = (label: string, ok: boolean): void => {
    if (ok) passed += 1;
    else failures.push(label);
  };

  const descPair = detectIndexOverlaps(DESC_TRAILING_PAIR);
  assert("a DESC-trailing pair is not an exact duplicate", redundant(descPair).length === 0);
  assert("a DESC-trailing pair is not a prefix overlap either", descPair.length === 0);

  const erased = detectIndexOverlaps(ORDERING_ERASED_PAIR);
  assert("the SAME pair with ordering erased IS detected — the control fires", erased.length === 1);
  assert(
    "and the droppable half is the PLAIN index, never the unique one",
    erased[0]?.verdict === "REDUNDANT" &&
      erased[0]?.candidate === "idx_crm_commission_plan_versions_lookup" &&
      erased[0]?.survivor === "uniq_crm_commission_plan_versions_effective",
  );
  const uniqueUnderPlain = detectIndexOverlaps([
    index({ tbl: "t", name: "idx_plain", keydef: "org_id:0,code:0" }),
    index({ tbl: "t", name: "uniq_code", keydef: "org_id:0,code:0", is_unique: true, backs_constraint: true }),
  ]);
  assert(
    "a UNIQUE is never dropped in favour of a non-unique — the plain one is the candidate",
    uniqueUnderPlain[0]?.candidate === "idx_plain" && uniqueUnderPlain[0]?.survivor === "uniq_code",
  );

  const droppable = detectIndexOverlaps([
    index({ tbl: "t", name: "idx_a", keydef: "org_id:0,status:0" }),
    index({ tbl: "t", name: "idx_b", keydef: "org_id:0,status:0" }),
  ]);
  assert("two identical plain indexes are REDUNDANT", redundant(droppable).length === 1);
  assert("and the survivor is the other one", droppable[0]?.survivor === "idx_b" && droppable[0]?.candidate === "idx_a");

  const constrained = detectIndexOverlaps([
    index({ tbl: "t", name: "idx_a", keydef: "org_id:0,status:0", backs_constraint: true }),
    index({ tbl: "t", name: "idx_b", keydef: "org_id:0,status:0", backs_constraint: true }),
  ]);
  assert("a constraint-backing index is never proposed for removal", redundant(constrained).length === 0);

  const prefix = detectIndexOverlaps(TENANT_PREFIX_PAIR);
  assert("a leading-prefix pair is reported", prefix.length === 1);
  assert("and always preserved", prefix[0]?.verdict === "PRESERVE" && prefix[0]?.preserveReason === "documented-access-pattern");

  const partial = detectIndexOverlaps([
    index({ tbl: "t", name: "idx_live", keydef: "org_id:0", predicate: "(deleted_at IS NULL)" }),
    index({ tbl: "t", name: "idx_all", keydef: "org_id:0,status:0" }),
  ]);
  assert("a partial index is not subsumed by a wider unfiltered one", partial.length === 0);

  const dupes = detectConstraintDuplicates(DUPLICATE_FKS);
  assert("two foreign keys with the same columns, parent and actions are REDUNDANT", redundant(dupes).length === 1);
  assert(
    "and the survivor is the lexicographically first name, so the report is stable",
    dupes[0]?.survivor === "fin_reimbursement_batches_approved_by_fkey",
  );
  assert(
    "one foreign key alone is not a duplicate — the control fires only on the pair",
    detectConstraintDuplicates(DUPLICATE_FKS.slice(0, 1)).length === 0,
  );

  const hot = TENANT_PREFIX_PAIR.map((entry) => ({ ...entry, idx_scan: 5_000_000, n_live_tup: 9_000_000 }));
  const cold = TENANT_PREFIX_PAIR.map((entry) => ({ ...entry, idx_scan: 0, n_live_tup: 0 }));
  assert(
    "statistics move no verdict — a never-scanned index and a hot one classify identically",
    JSON.stringify(detectIndexOverlaps(hot).map((o) => [o.id, o.verdict])) ===
      JSON.stringify(detectIndexOverlaps(cold).map((o) => [o.id, o.verdict])),
  );
  assert(
    "a never-scanned index that duplicates nothing is not a finding at any scan count",
    detectIndexOverlaps([index({ tbl: "t", name: "idx_lonely", keydef: "org_id:0,kind:0", idx_scan: 0 })]).length === 0,
  );
  assert("statisticsAreInert agrees over the whole fixture set", statisticsAreInert([...TENANT_PREFIX_PAIR, ...DESC_TRAILING_PAIR], DUPLICATE_FKS));

  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.log(`check-redundant-objects --self-test: ${String(passed)} passed, ${String(failures.length)} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}
