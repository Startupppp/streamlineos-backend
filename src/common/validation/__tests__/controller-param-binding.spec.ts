import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

/**
 * PRD-C048 — every path parameter reaches a handler through a validation boundary.
 *
 * `@Validate({ body })` was applied almost everywhere and `check:body-binding` reports
 * 0 unbound bodies, but the PARAM half had no gate at all, so eight bindings across
 * three controllers took a raw path segment with neither a pipe nor a
 * `@Validate({ params })`: `platform-operator-access.controller.ts` bound a Postgres
 * `uuid` column as free text (an invalid segment failed `22P02` inside the query
 * instead of 400 at the boundary), `gdpr.controller.ts` handed an unchecked id to the
 * export and erasure services, and `public.controller.ts` did it on two
 * UNAUTHENTICATED routes.
 *
 * A pipe (`ParseIntPipe` and friends) counts as a boundary — it rejects before the
 * handler body runs.
 *
 * ⚠ The assertion used to be a flat zero, on the argument that "the repository is at
 * zero now, so anything above zero is a new defect rather than inherited debt". That
 * argument was true of the tree it was written against and is no longer true of this
 * one: merging the Inventory/CRM/Timesheets/SignOS branch and the accounting rewrite
 * into main brought 113 bindings across 28 controllers that never had this gate
 * applied to them. Flat zero would now fail on 113 pre-existing sites and say nothing
 * about the next one, which is the failure mode a ratchet exists to avoid.
 *
 * So the zero survives where it can still mean zero — a controller NOT in the record
 * below may not have a single unvalidated binding — and the inherited sites are
 * enumerated per file with the lane that owns them. The record is exact, not a
 * ceiling: fixing one of a file's nine fails this suite until the number is brought
 * down with it, so every shrink is deliberate and auditable, and a tenth can never
 * hide inside a file that was already dirty.
 *
 * None of the 113 is a live defect. The three on `@Public()` routes were checked by
 * hand: both CRM unsubscribe links run the segment through `verifyUnsubscribeToken`,
 * which fails closed, and the WhatsApp channel id is a `text` primary key resolved
 * through `app.resolve_whatsapp_channel_org_id_by_id(text)`, so none of them can
 * reach a `uuid` column and raise `22P02` the way the three original PRD-C048
 * defects did. They are validation debt, not an open hole.
 *
 * The query half is asserted only over the two controllers this ticket fixed. 40 raw
 * `@Query("x")` bindings remain elsewhere, owned by other module lanes; pinning them
 * here would be claiming their work.
 */

const BACKEND_ROOT = resolve(__dirname, "..", "..", "..", "..");

function controllerFiles(directory = "src"): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(BACKEND_ROOT, directory), { withFileTypes: true })) {
    const file = posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...controllerFiles(file));
    } else if (entry.name.endsWith(".controller.ts") && !entry.name.endsWith(".spec.ts")) {
      files.push(file);
    }
  }
  return files;
}

/**
 * The decorator block + signature for the handler that owns line `index`, found by
 * walking back to the previous method's closing brace at class-member indentation.
 */
function handlerWindow(lines: string[], index: number): string {
  let start = index;
  while (start > 0 && !/^ {2}\}/.test(lines[start - 1] ?? "")) start--;
  return lines.slice(start, index + 1).join("\n");
}

interface Site {
  file: string;
  line: number;
  text: string;
}

function unvalidatedBindings(files: string[], kind: "Param" | "Query"): Site[] {
  const decorator = new RegExp(`@${kind}\\(\\s*"([^"]+)"\\s*(,)?`);
  const key = kind === "Param" ? "params" : "query";
  const sites: Site[] = [];
  for (const file of files) {
    const lines = readFileSync(join(BACKEND_ROOT, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = decorator.exec(lines[i] ?? "");
      if (!match) continue;
      // A pipe is a boundary in its own right: it rejects before the handler runs.
      if (match[2] === ",") continue;
      const window = handlerWindow(lines, i);
      const validate = /@Validate\(\{[\s\S]*?\}\)/.exec(window);
      if (validate && new RegExp(`\\b${key}\\s*:`).test(validate[0])) continue;
      sites.push({ file, line: i + 1, text: (lines[i] ?? "").trim() });
    }
  }
  return sites;
}

/**
 * Every controller carrying a `@Param` binding that crosses no validation boundary,
 * and how many, as the merge left it. Shrink-only, and exact — see the header.
 *
 * Grouped by the lane that owes the fix, because no single lane can pay this down:
 * the accounting rewrite is 63 of the 113, and CRM, deals, reporting and inventory
 * are being worked in parallel.
 */
const INHERITED_UNVALIDATED_PARAMS: Readonly<Record<string, number>> = {
  // Accounting rewrite — the gl_* kernel and the AP/AR/banking surfaces on top of it.
  "src/modules/accounting/ap/ap-documents.controller.ts": 5,
  "src/modules/accounting/ap/ap-payments.controller.ts": 4,
  "src/modules/accounting/ar/ar-credit-notes.controller.ts": 7,
  "src/modules/accounting/ar/ar-invoices.controller.ts": 8,
  "src/modules/accounting/ar/ar-receipts.controller.ts": 4,
  "src/modules/accounting/attachments/attachments.controller.ts": 3,
  "src/modules/accounting/banking/bank-accounts.controller.ts": 4,
  "src/modules/accounting/banking/bank-statements.controller.ts": 4,
  "src/modules/accounting/banking/matching.controller.ts": 4,
  "src/modules/accounting/compliance/compliance.controller.ts": 4,
  "src/modules/accounting/kernel/kernel.controller.ts": 9,
  "src/modules/accounting/parties/parties.controller.ts": 7,
  // CRM and the surfaces that grew out of it.
  "src/modules/autonomy/autonomy-review.controller.ts": 2,
  "src/modules/autonomy/cold-outbound-admin.controller.ts": 2,
  "src/modules/autonomy/sequences/nurture-sequences.controller.ts": 8,
  "src/modules/commission/commission-accrual.controller.ts": 1,
  "src/modules/commission/commission.controller.ts": 9,
  "src/modules/crm/consent/crm-consent.controller.ts": 2,
  "src/modules/crm/segments/crm-segments.controller.ts": 4,
  "src/modules/deals/deals-competitor-suggestions.controller.ts": 2,
  "src/modules/ingress/adapters/whatsapp-channels.controller.ts": 3,
  "src/modules/ingress/adapters/whatsapp-ingress.controller.ts": 2,
  "src/modules/lifecycle/customer-health.controller.ts": 2,
  "src/modules/lifecycle/lifecycle-triggers.controller.ts": 1,
  "src/modules/lifecycle/lifecycle.controller.ts": 4,
  "src/modules/reporting/report-schedules.controller.ts": 3,
  "src/modules/reporting/reporting.controller.ts": 4,
  // Inventory.
  "src/modules/inventory/warehouses/inv-warehouses.controller.ts": 1,
};

describe("PRD-C048 — path parameters cross a validation boundary", () => {
  const files = controllerFiles();

  it("scans a real controller corpus", () => {
    // Anti-vacuity: a broken walk or a moved root would make every assertion below pass.
    expect(files.length).toBeGreaterThan(400);
    expect(new Set(files).size).toBe(files.length);
    expect(files.every((file) => file.startsWith("src/") && file.endsWith(".controller.ts"))).toBe(true);
    expect(files.some((file) => file.includes("\\") || file.endsWith(".spec.ts"))).toBe(false);
    expect(controllerFiles()).toEqual(files);
  });

  const sites = unvalidatedBindings(files, "Param");
  const measured: Record<string, number> = {};
  for (const site of sites) measured[site.file] = (measured[site.file] ?? 0) + 1;

  it("no @Param binding lacks both a pipe and @Validate({ params }) outside the record", () => {
    const unrecorded = sites
      .filter((site) => !(site.file in INHERITED_UNVALIDATED_PARAMS))
      .map((site) => `${site.file}:${String(site.line)}  ${site.text}`);

    // Still zero for every controller the merge did not bring debt in on: the record
    // is a list of files already known to owe a fix, never a way in for a new one.
    expect(unrecorded).toEqual([]);
  });

  it("holds the recorded debt exactly, so it can only be paid down deliberately", () => {
    // Both directions. Above the number is a new unvalidated binding hiding inside a
    // file that was already dirty; below it is a fix that left the record claiming
    // debt nobody owes, which is how a ratchet stops being read.
    expect(measured).toEqual(INHERITED_UNVALIDATED_PARAMS);
  });

  it("keeps the record honest about its own size", () => {
    // Anti-vacuity from the other side: a record that quietly grew would make the
    // per-file case above pass while the repository got worse.
    expect(sites).toHaveLength(113);
    expect(Object.values(INHERITED_UNVALIDATED_PARAMS).reduce((a, b) => a + b, 0)).toBe(113);
  });

  it("detects an unvalidated binding when one exists", () => {
    // The detector itself is exercised, so "zero findings" cannot mean "finds nothing".
    const lines = [
      "  @Get(\"thing/:thingId\")",
      "  getThing(",
      "    @Param(\"thingId\") thingId: string,",
      "  ) {",
      "    return thingId;",
      "  }",
    ];
    const window = handlerWindow(lines, 2);
    expect(/@Validate\(/.test(window)).toBe(false);
  });
});

describe("PRD-C048 — the HR automations list routes bind their query through Zod", () => {
  const HR_FILES = [
    "src/modules/hr/automations/hr-webhooks.controller.ts",
    "src/modules/hr/automations/hr-automations.controller.ts",
  ];

  it("no raw keyed @Query survives in either controller", () => {
    const sites = unvalidatedBindings(HR_FILES, "Query");
    expect(sites.map((site) => `${site.file}:${String(site.line)}  ${site.text}`)).toEqual([]);
  });

  it("neither controller clamps a page size by hand any more", () => {
    for (const file of HR_FILES) {
      const source = readFileSync(join(BACKEND_ROOT, file), "utf8");
      // A hand-rolled clamp is invisible to @Validate, so the cap never reaches openapi.json.
      expect([file, /Math\.min\(\s*100\s*,/.test(source)]).toEqual([file, false]);
      expect([file, source.includes("parseInt(")]).toEqual([file, false]);
      expect([file, source.includes("pageSizeField")]).toEqual([file, false]);
    }
  });

  it("the list schemas declare the page-size cap that reaches the document", () => {
    for (const dto of [
      "src/modules/hr/automations/dto/hr-webhook.schemas.ts",
      "src/modules/hr/automations/dto/hr-automation.schemas.ts",
    ]) {
      const source = readFileSync(join(BACKEND_ROOT, dto), "utf8");
      expect([dto, source.includes("pageSizeField(50, 100)")]).toEqual([dto, true]);
    }
  });
});
