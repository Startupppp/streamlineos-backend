import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNTING_PERMISSIONS } from "../rbac/permissions/accounting";
import { PERMISSIONS } from "../rbac/permissions/catalog";

/**
 * Accounting declares NO `scopable` permission, and this is where that decision
 * is written down.
 *
 * `src/scripts/census-scopable-keys-unenforced.mjs` flagged four —
 * `accounting:journal:read`, `accounting:receivables:read`,
 * `accounting:payables:read` and `accounting:approvals:read` — as declared
 * scopable with nothing enforcing them. Verified by hand: all eleven read
 * routes across `kernel.controller.ts`, `ar-invoices`, `ar-receipts`,
 * `ar-aging`, `ap-documents` and `ap-payments` pass `orgId` alone. No private
 * helper, no service-layer narrowing, no guard.
 *
 * That mattered because the loop closes: `PermissionGuard` resolves the grant
 * and attaches it as `req.rbacScope`, then ALLOWS the request — narrowing is
 * the route's job, and none of these routes opt in. So an administrator could
 * pick `own` on the access screen (`isScopable` drives that dropdown), the
 * grant stored at `own`, and every invoice in the organisation came back.
 *
 * The answer was `scopable: false` rather than enforcement, per key, for
 * reasons recorded on each declaration in `rbac/permissions/accounting.ts` —
 * the short version being that a ledger read has no honest per-person owner:
 * `created_by` is who keyed the row, `gl_parties` has no owner column at all,
 * and the aggregates over the same rows are not scopable and could not be.
 *
 * Dormancy was confirmed before changing anything, because switching a
 * restriction on or off must not move rows: `role_permission_grants.scope` and
 * `user_permission_grants.scope` both default to `all`; no role template
 * carries a scope at all; and the only two migrations that ever wrote a
 * narrower one (`0457`, `0545`) name `sign:envelope:view` and
 * `crm:commission-earnings:view`. No accounting grant exists at `own` to lose.
 */
describe("accounting permission scopability", () => {
  const scopableAccountingKeys = ACCOUNTING_PERMISSIONS
    .filter((permission) => permission.scopable === true)
    .map((permission) => permission.name)
    .sort();

  it("declares no scopable key, and the next one added must be enforced first", () => {
    /*
     * The forward rule. Adding `scopable: true` to an accounting key turns this
     * red, and the message is the instruction: a scopable key must have a route
     * that reads `req.rbacScope` and narrows, the way `deals-crud.service.ts`
     * and `survey-forms.service.ts` do. Declaring one without that is not a
     * smaller version of enforcing it — it is a restriction an administrator
     * can select and the data will ignore.
     */
    expect(scopableAccountingKeys).toEqual([]);
  });

  it("still declares the four keys the census flagged", () => {
    /*
     * Anti-vacuity. Without this the assertion above would also pass if the
     * keys were deleted, or renamed, or the file emptied.
     */
    const names = new Set(ACCOUNTING_PERMISSIONS.map((permission) => permission.name));
    for (const key of [
      "accounting:journal:read",
      "accounting:receivables:read",
      "accounting:payables:read",
      "accounting:approvals:read",
    ]) {
      expect(names.has(key)).toBe(true);
    }
  });

  it("is a real constraint, because other modules do declare scopable keys", () => {
    /*
     * The second anti-vacuity floor: if `scopable` were removed from the
     * catalog wholesale, or the flag stopped being read, "accounting declares
     * none" would become true for a reason that has nothing to do with this
     * decision. Pin that the mechanism is still live elsewhere.
     */
    const scopableElsewhere = PERMISSIONS.filter(
      (permission) =>
        permission.scopable === true && !permission.name.startsWith("accounting:"),
    );
    expect(scopableElsewhere.length).toBeGreaterThan(0);
  });

  it("keeps the AR invoice list free of a caller predicate, and says so where a census will read it", () => {
    /*
     * Pinned as SOURCE, not behaviour, following `getCrmAssignmentStats` in
     * `client-accounts-record-scope.spec.ts`: the correct behaviour here is the
     * ABSENCE of a predicate, and there is no way to assert an absence without
     * also asserting it stayed deliberate.
     *
     * `GET accounting/ar/invoices` is the census's headline example — the route
     * where "grant `own`, see everything" was demonstrated. Matching the code
     * form rather than a word: this looks for the handler still passing the
     * tenant and nothing else, which is exactly what would change if somebody
     * narrowed it. If you are here because this went red: good — you are adding
     * enforcement, so update the reasoning on the declaration too, and check
     * `ArAgingService.balanced` still means what it says over your subset.
     */
    const source = readFileSync(join(__dirname, "ar", "ar-invoices.controller.ts"), "utf8");

    expect(source).toContain('return this.documents.list(u.orgId, "INVOICE", query);');
  });
});
