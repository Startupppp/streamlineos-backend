import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe as narrate } from "./compliance-narrative";

/**
 * ACC-12. The product must never imply a document was filed with a tax
 * authority unless an authority actually took it.
 *
 * Two halves, and the second is the one that was missing.
 *
 * **Not lying.** `ComplianceService` only ever writes `not_required` or
 * `pending`, and never an `authorityId`. That is true today by the accident of
 * no transport existing; the scan below turns it into a rule, so ACC-13's mock
 * adapter and ACC-14's real one have to earn the word "accepted" rather than
 * inherit it.
 *
 * **Not staying silent.** `ComplianceService.get` had no caller anywhere — no
 * route, no place in the AR document view. So on an Indian B2B invoice the
 * product decided an IRN was owed, wrote that down, sent nothing, and told the
 * person who raised the invoice nothing at all. They are left believing they
 * issued a compliant document. A false claim of filing and a silence about an
 * unmet obligation are the same failure wearing different clothes.
 */

const ACCOUNTING_ROOT = join(__dirname, "..");

function productionFiles(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return productionFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".spec.ts") && !full.endsWith(".e2e-spec.ts")
      ? [full]
      : [];
  });
}

const FILES = productionFiles(ACCOUNTING_ROOT);

/**
 * The two places allowed to produce a success status or an acknowledgement,
 * and why each earned it. ACC-13 said an adapter would have to earn this rather
 * than be exempted from it, so the entry comes with the rule that replaces the
 * blanket ban:
 *
 *  - `transport/**` — an adapter is the only thing that can obtain an
 *    acknowledgement, real or synthetic. What replaces the ban is the pair of
 *    assertions below: a synthetic adapter's output must be visibly synthetic,
 *    proven by CALLING it, and no adapter may claim to be real until ACC-14
 *    lands with credentials.
 *  - `compliance.service.ts` — records what an adapter returned. Every value it
 *    writes comes out of a `TransportResult`; it has no literal of its own, and
 *    the `columnsFor` switch is asserted to be the only writer.
 */
const ACKNOWLEDGEMENT_WRITERS = [
  "transport/",
  "compliance.service.ts",
];

const isAllowedWriter = (relPath: string): boolean =>
  ACKNOWLEDGEMENT_WRITERS.some((allowed) => relPath.replaceAll("\\", "/").includes(allowed));

describe("nothing claims a document was filed", () => {
  it("scans a real number of files", () => {
    /* The floor: a broken walk would make the two scans below pass over nothing. */
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("writes no success status while no transport adapter exists", () => {
    /*
      `submitted` and `accepted` are statements about what an authority did.
      With no connector in the product, any code setting one is asserting
      something that did not happen. When ACC-13 lands a mock and ACC-14 a real
      provider, the adapter that gets to write these becomes the allowlist entry
      — and adding it will be a deliberate act rather than a line nobody
      noticed.
    */
    const writers: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const relPath = relative(ACCOUNTING_ROOT, file);
      if (isAllowedWriter(relPath)) continue;
      if (/status:\s*["'](submitted|accepted)["']/.test(source)) {
        writers.push(relPath);
      }
    }
    expect(writers).toEqual([]);
  });

  it("writes no authority acknowledgement while nothing can receive one", () => {
    /*
      An `authorityId` or `ackNo` is an IRN — a number issued by the government.
      There is no code path that could obtain one, so any code path that sets
      one is inventing it, and an invented IRN is the single worst artefact this
      pack could ship.
    */
    const writers: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const relPath = relative(ACCOUNTING_ROOT, file);
      if (isAllowedWriter(relPath)) continue;
      if (/\b(authorityId|ackNo)\s*:\s*(?!undefined|null)["'`]/.test(source)) {
        writers.push(relPath);
      }
    }
    expect(writers).toEqual([]);
  });

  it("catches a planted claim, so the scan is not decorative", () => {
    /* Both patterns, proven against the strings they exist to find. */
    expect(/status:\s*["'](submitted|accepted)["']/.test('status: "accepted",')).toBe(true);
    expect(/status:\s*["'](submitted|accepted)["']/.test('status: "pending",')).toBe(false);
    expect(/\b(authorityId|ackNo)\s*:\s*(?!undefined|null)["'`]/.test('ackNo: "112420000000",')).toBe(
      true,
    );
    expect(/\b(authorityId|ackNo)\s*:\s*(?!undefined|null)["'`]/.test("authorityId: null,")).toBe(
      false,
    );
  });
});

describe("how a compliance state is described to a person", () => {
  const base = { transport: "irp", authorityId: null, ackNo: null };

  it("never calls a pending document filed, and says why nobody will send it", () => {
    /*
      `pending` is the word that does the damage. Everywhere else it means "in
      flight, wait"; here it means "reportable, and there is no connection to
      report it over". A UI rendering the raw enum would show a spinner for a
      request that will never be made — a more convincing lie than a wrong
      label.
    */
    const narrative = narrate({ ...base, status: "pending" });

    expect(narrative.filed).toBe(false);
    expect(narrative.headline).toMatch(/has not been sent/);
    expect(narrative.headline).toMatch(/no connection to that authority/);
    expect(narrative.action).toMatch(/outside this product/);
  });

  it("does not call a submitted document filed either", () => {
    /*
      Submitted is not filed: the authority holds it and has not answered, and a
      rejected invoice passed through this state on its way to being rejected.
    */
    expect(narrate({ ...base, status: "submitted" }).filed).toBe(false);
  });

  it("calls a document filed only with an acknowledgement in hand", () => {
    expect(narrate({ ...base, status: "accepted", ackNo: "112420000000" }).filed).toBe(true);
  });

  it("refuses to call an accepted document filed when no IRN was stored", () => {
    /*
      The row says the authority took it and nothing recorded what it gave back.
      That is a bug upstream, and the honest reading of it is "unfiled" — the
      flattering reading would hand someone a compliance claim with no evidence
      behind it.
    */
    const narrative = narrate({ ...base, status: "accepted" });

    expect(narrative.filed).toBe(false);
    expect(narrative.headline).toMatch(/no acknowledgement number was stored/);
    expect(narrative.action).toMatch(/whether this document was actually received/);
  });

  it("says nothing is owed when nothing is owed", () => {
    const narrative = narrate({ ...base, transport: "none", status: "not_required" });
    expect(narrative.filed).toBe(false);
    expect(narrative.action).toBeNull();
  });

  it("defaults an unknown status to unfiled rather than to filed", () => {
    /*
      A new member of `compliance_status` added without a branch here must fail
      towards the honest answer. This is the one default that has to be chosen
      rather than inherited.
    */
    const narrative = narrate({ ...base, status: "queued_for_retry" });
    expect(narrative.filed).toBe(false);
    expect(narrative.headline).toMatch(/not one this product can explain/);
  });

  it("is filed for exactly one status", () => {
    /*
      Enumerated rather than spot-checked: any future branch that sets
      `filed: true` has to come here and justify itself.
    */
    const statuses = [
      "not_required",
      "pending",
      "submitted",
      "accepted",
      "rejected",
      "cancelled",
    ];
    const filed = statuses.filter(
      (status) => narrate({ ...base, status, ackNo: "112420000000" }).filed,
    );
    expect(filed).toEqual(["accepted"]);
  });
});

describe("the compliance state is reachable", () => {
  it("has a route, which is the whole of the silence half", () => {
    const module = readFileSync(join(__dirname, "accounting-compliance.module.ts"), "utf8");
    expect(module).toContain("controllers: [ComplianceController]");

    const controller = readFileSync(join(__dirname, "compliance.controller.ts"), "utf8");
    expect(controller).toContain('@Get("documents/:documentType/:documentId")');
    expect(controller).toContain('@RequirePermission("accounting:receivables:read")');
  });
});
