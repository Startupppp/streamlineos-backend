import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * T04 — a status guard may not stand in front of the claim it invalidates.
 *
 * `runIdempotent` exists so a client whose request timed out can retry and be
 * told what happened the first time. A guard placed before the claim, on a
 * status the command's own effect changes, makes that impossible: the first call
 * flips the status, and the retry is refused on the status its own first run set
 * — without ever reaching the guard that would have replayed the answer.
 *
 * `6c8f68fc9` fixed two of these. A hand sweep of all 39 call sites found four
 * more and **missed a fifth** (`pickSo`), which this check found on its first
 * run. That is the argument for having it: the defect is invisible to every unit
 * suite, because each half is correct on its own.
 *
 * The rule is textual and therefore blunt: it flags a `throw` whose condition
 * reads `.status`, before `runIdempotent(` in the same method. That over-reaches
 * — a guard on a status the command never writes is sound. Those are named
 * below with a reason each, in the same shape `NO_DATA_ROUTES` and
 * `NOT_JOURNALLED` use elsewhere, so an exemption has to be argued for rather
 * than assumed.
 */
const INVENTORY = resolve(process.cwd(), "src/modules/inventory");

/**
 * A guard that stands before the claim and is sound, because the command cannot
 * reach the status it tests. Each entry says why.
 */
const CANNOT_INVALIDATE: ReadonlyArray<{ file: string; method: string; reason: string }> = [
  {
    file: "shipments/lib/shipment-dispatch.ts",
    method: "shipShipment",
    reason:
      "Guards on CANCELLED and on the sales order's own status. Shipping sets SHIPPED on the shipment; it never sets CANCELLED, and the SO status it reads is written by the SO, not here.",
  },
  {
    file: "landed-cost/landed-cost-apply.service.ts",
    method: "applyVoucher",
    reason:
      "Guards on grn.status !== POSTED. Applying a landed-cost voucher writes the voucher and the valuation, never the GRN's status, so the precondition survives its own effect.",
  },
  {
    file: "channels/quick-commerce/lib/quick-commerce-accept.ts",
    method: "acceptPurchaseOrder",
    reason:
      "Guards on REJECTED and CANCELLED. Accepting sets ACCEPTED; it cannot produce either of the statuses it refuses, so a retry reaches the claim.",
  },
];

/**
 * `*.service.ts` AND everything under a `lib/` directory.
 *
 * The `.service.ts` walk alone had a hole that opened as soon as a large
 * service was decomposed: the flows that call `runIdempotent` move into
 * `lib/`, the class keeps a delegate that does not, and this check goes quiet
 * on exactly the code it was written for. Widened 2026-09-11 when
 * `acceptPurchaseOrder` moved to `channels/quick-commerce/lib/`; the floor
 * below asserts the walk still reaches enough claiming files to mean anything.
 */
const serviceFiles = readdirSync(INVENTORY, { recursive: true, encoding: "utf8" })
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
  .filter((f) => f.endsWith(".service.ts") || /(^|\/)lib\//.test(f))
  .sort();

/** Method bodies, keyed by name, for every method that claims an idempotency key. */
function claimingMethods(source: string): Array<{ name: string; beforeClaim: string }> {
  // Class members (two-space indent) and module-level functions alike — the
  // second shape is what a decomposed service's `lib/` file is made of.
  const starts = [
    ...source.matchAll(
      /\n(?: {2}(?:private )?(?:async )?([A-Za-z_][A-Za-z0-9_]*)\(|(?:export )?(?:async )?function ([A-Za-z_][A-Za-z0-9_]*)\()/g,
    ),
  ];
  const out: Array<{ name: string; beforeClaim: string }> = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.index!;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : source.length;
    const body = source.slice(from, to);
    const claim = body.indexOf("runIdempotent(");
    if (claim === -1) continue;
    out.push({ name: (starts[i]![1] ?? starts[i]![2])!, beforeClaim: body.slice(0, claim) });
  }
  return out;
}

const GUARD = /if\s*\([^)]*\.status[^)]*\)\s*(?:\{[^}]*)?throw new \w+/s;

describe("T04 — a status guard may not stand in front of the claim it invalidates", () => {
  it("finds the services at all, so a broken walk cannot pass as zero violations", () => {
    expect(serviceFiles.length).toBeGreaterThan(150);
    const claiming = serviceFiles.filter((f: string) =>
      readFileSync(resolve(INVENTORY, f), "utf8").includes("runIdempotent("),
    );
    expect(claiming.length).toBeGreaterThanOrEqual(30);

    // The specific regression this floor exists for: the `.service.ts`-only
    // walk reached 27 claiming files and MISSED five in `lib/`, two of them
    // (`sales-orders/lib/so-pack.ts`, `so-pick-pack.ts`) already there before
    // this was noticed. A decomposition must not be able to empty this check.
    expect(claiming.filter((f: string) => /(^|\/)lib\//.test(f)).length).toBeGreaterThanOrEqual(5);
  });

  it("keeps every status guard inside the claim, or names why it cannot invalidate it", () => {
    const exempt = new Set(CANNOT_INVALIDATE.map((e) => `${e.file}::${e.method}`));
    const violations: string[] = [];

    for (const file of serviceFiles) {
      const source = readFileSync(resolve(INVENTORY, file), "utf8");
      if (!source.includes("runIdempotent(")) continue;
      for (const { name, beforeClaim } of claimingMethods(source)) {
        if (!GUARD.test(beforeClaim)) continue;
        if (exempt.has(`${file}::${name}`)) continue;
        violations.push(
          `${file} :: ${name} throws on a status before runIdempotent — move it inside the claim, ` +
            `or add it to CANNOT_INVALIDATE with the reason the command cannot reach that status`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps every exemption pointed at a method that still exists", () => {
    // An exemption for a method that has been renamed or deleted is a hole that
    // reads as a rule. This is the same argument the migration exclusions make.
    const stale = CANNOT_INVALIDATE.filter((e) => {
      const path = resolve(INVENTORY, e.file);
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        return true;
      }
      return !claimingMethods(source).some((m) => m.name === e.method);
    }).map((e) => `${e.file}::${e.method}`);

    expect(stale).toEqual([]);
  });

  it("gives every exemption a reason somebody can read", () => {
    for (const entry of CANNOT_INVALIDATE) {
      expect(entry.reason.length).toBeGreaterThan(60);
    }
  });
});
