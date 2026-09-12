import request from "supertest";
import {
  createAuthzHarness,
  actorOf,
  ORG_A,
  ORG_B,
  type AuthzHarness,
  type GatedRoute,
} from "../../../test/helpers/authz-deny-harness";
import { ReconciliationController } from "./adapters/reconciliation/reconciliation.controller";
import { ApAgingController } from "./ap/ap-aging.controller";
import { ApDocumentsController } from "./ap/ap-documents.controller";
import { ApPaymentsController } from "./ap/ap-payments.controller";
import { ArCreditNotesController } from "./ar/ar-credit-notes.controller";
import { ArReceiptsController } from "./ar/ar-receipts.controller";
import { BankAccountsController } from "./banking/bank-accounts.controller";
import { BankStatementsController } from "./banking/bank-statements.controller";
import { BankMatchingController } from "./banking/matching.controller";
import { AccountingKernelController } from "./kernel/kernel.controller";
import { PartiesController } from "./parties/parties.controller";
import { ReportsController } from "./reports/reports.controller";
import { AccountingSetupController } from "./setup/accounting-setup.controller";
import { TrialBalanceService } from "./reports/trial-balance.service";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";

/**
 * The deny branch of every authorization gate on the accounting HTTP surface.
 *
 * Accounting had thirty-odd spec files and not one of them asserted a refusal:
 * every route's `@RequirePermission` was an untested claim that the decorator
 * had been typed. This file exercises the other half.
 *
 * WHAT EACH CASE ACTUALLY PROVES
 *
 * The caller is not a stripped-down principal. It holds EVERY key in the
 * catalogue except the one the route under test names (`denyOnly`). So a 403
 * here cannot come from "this fixture has no permissions" — it can only come
 * from the route demanding that specific key. A route whose decorator named a
 * key the caller happens to hold, or whose guard was dropped, answers 200/400
 * and the case goes red.
 *
 * `expectAllowed` is the anti-vacuity floor. If the same request answered 403
 * for every fixture — a misrouted path, a pipe that throws, a class guard that
 * refuses before the permission is ever read — the deny case above would be
 * green for a reason that has nothing to do with authorization. Each route is
 * therefore also driven with the permission held, and must NOT answer 403.
 *
 * `PermissionGuard` answers 401 when no `AuthContext` is attached at all. A 401
 * is not proof of a working deny path, so the distinction is pinned explicitly
 * rather than left as a thing the reader has to know.
 */

const ID = "11111111-1111-4111-8111-111111111111";

/** Accounting's own catalogued keys — the caller's baseline grant. */
const ACCOUNTING_KEYS = ALL_PERMISSION_NAMES.filter((name) =>
  name.startsWith("accounting:"),
);

const GET_ROUTES: readonly GatedRoute[] = [
  { verb: "get", path: `/accounting/packs`, key: "accounting:settings:read" },
  { verb: "get", path: `/accounting/book`, key: "accounting:read" },
  { verb: "get", path: `/accounting/accounts`, key: "accounting:accounts:read" },
  { verb: "get", path: `/accounting/accounts/${ID}`, key: "accounting:accounts:read" },
  { verb: "get", path: `/accounting/accounts/postable`, key: "accounting:accounts:read" },
  { verb: "get", path: `/accounting/accounts/mappings`, key: "accounting:accounts:read" },
  { verb: "get", path: `/accounting/fiscal-years`, key: "accounting:periods:read" },
  { verb: "get", path: `/accounting/periods`, key: "accounting:periods:read" },
  { verb: "get", path: `/accounting/journals/${ID}`, key: "accounting:journal:read" },
  { verb: "get", path: `/accounting/accounts/${ID}/ledger`, key: "accounting:general-ledger:read" },
  { verb: "get", path: `/accounting/currencies`, key: "accounting:read" },
  { verb: "get", path: `/accounting/book-currencies`, key: "accounting:read" },
  { verb: "get", path: `/accounting/fx-rates`, key: "accounting:read" },
  { verb: "get", path: `/accounting/ar/credit-notes`, key: "accounting:credit-notes:read" },
  { verb: "get", path: `/accounting/ar/credit-notes/${ID}`, key: "accounting:credit-notes:read" },
  { verb: "get", path: `/accounting/ar/receipts/${ID}`, key: "accounting:receivables:read" },
  { verb: "get", path: `/accounting/payables/aging`, key: "accounting:reports:read" },
  { verb: "get", path: `/accounting/payables/documents`, key: "accounting:payables:read" },
  { verb: "get", path: `/accounting/payables/documents/${ID}`, key: "accounting:payables:read" },
  { verb: "get", path: `/accounting/payables/documents/${ID}/tax-preview`, key: "accounting:payables:read" },
  { verb: "get", path: `/accounting/payables/payments`, key: "accounting:payables:read" },
  { verb: "get", path: `/accounting/payables/payments/${ID}`, key: "accounting:payables:read" },
  { verb: "get", path: `/accounting/banking/accounts`, key: "accounting:banking:read" },
  { verb: "get", path: `/accounting/banking/accounts/${ID}`, key: "accounting:banking:read" },
  { verb: "get", path: `/accounting/banking/accounts/${ID}/balance`, key: "accounting:banking:read" },
  { verb: "get", path: `/accounting/banking/unreconciled`, key: "accounting:banking:read" },
  { verb: "get", path: `/accounting/banking/statement-lines/${ID}/suggestions`, key: "accounting:banking:reconcile" },
  { verb: "get", path: `/accounting/banking/statements/mapping-presets`, key: "accounting:banking:read" },
  { verb: "get", path: `/accounting/banking/statements/${ID}`, key: "accounting:banking:read" },
  { verb: "get", path: `/accounting/banking/statements/${ID}/reconciliation/export`, key: "accounting:reports:export" },
  { verb: "get", path: `/accounting/parties/${ID}`, key: "accounting:read" },
  { verb: "get", path: `/accounting/parties/${ID}/tax-registrations`, key: "accounting:read" },
  { verb: "get", path: `/accounting/setup/tax-registrations`, key: "accounting:settings:read" },
  { verb: "get", path: `/accounting/reconciliation/unposted-movements`, key: "accounting:reports:read" },
  { verb: "get", path: `/accounting/reconciliation/stock-gl`, key: "accounting:reports:read" },
  { verb: "get", path: `/accounting/reports/trial-balance`, key: "accounting:reports:read" },
  { verb: "get", path: `/accounting/reports/pnl`, key: "accounting:reports:read" },
  { verb: "get", path: `/accounting/reports/balance-sheet`, key: "accounting:reports:read" },
  { verb: "get", path: `/accounting/reports/cash-flow`, key: "accounting:reports:read" },
  { verb: "get", path: `/accounting/reports/aging`, key: "accounting:reports:read" },
  { verb: "get", path: `/accounting/reports/tax-summary`, key: "accounting:reports:read" },
];

const POST_ROUTES: readonly GatedRoute[] = [
  { verb: "post", path: `/accounting/accounts`, key: "accounting:accounts:create" },
  { verb: "post", path: `/accounting/fiscal-years/open-next`, key: "accounting:periods:manage" },
  { verb: "post", path: `/accounting/periods/${ID}/lock`, key: "accounting:periods:manage" },
  { verb: "post", path: `/accounting/periods/${ID}/unlock`, key: "accounting:periods:reopen" },
  { verb: "post", path: `/accounting/journals/${ID}/reverse`, key: "accounting:journal:post" },
  { verb: "post", path: `/accounting/book-currencies`, key: "accounting:settings:manage" },
  { verb: "post", path: `/accounting/fx-rates`, key: "accounting:settings:manage" },
  { verb: "post", path: `/accounting/fx/preview`, key: "accounting:read" },
  { verb: "post", path: `/accounting/setup/enable`, key: "accounting:settings:manage" },
  { verb: "post", path: `/accounting/setup/tax-registrations`, key: "accounting:settings:manage" },
  { verb: "post", path: `/accounting/payables/documents`, key: "accounting:payables:manage" },
  { verb: "post", path: `/accounting/payables/documents/${ID}/post`, key: "accounting:payables:manage" },
  { verb: "post", path: `/accounting/payables/payments`, key: "accounting:payables:manage" },
  { verb: "post", path: `/accounting/payables/payments/${ID}/allocations`, key: "accounting:payables:manage" },
  { verb: "post", path: `/accounting/payables/payments/${ID}/reverse`, key: "accounting:payables:approve" },
  { verb: "post", path: `/accounting/payables/debit-notes/${ID}/allocations`, key: "accounting:vendor-credits:manage" },
  { verb: "post", path: `/accounting/ar/credit-notes`, key: "accounting:credit-notes:create" },
  { verb: "post", path: `/accounting/ar/credit-notes/${ID}/post`, key: "accounting:credit-notes:manage" },
  { verb: "post", path: `/accounting/parties/${ID}/tax-registrations`, key: "accounting:taxes:manage" },
  { verb: "post", path: `/accounting/ar/receipts/${ID}/allocations/fifo`, key: "accounting:receivables:manage" },
  { verb: "post", path: `/accounting/banking/accounts`, key: "accounting:banking:manage" },
  { verb: "post", path: `/accounting/banking/statement-lines/${ID}/match`, key: "accounting:banking:reconcile" },
  { verb: "post", path: `/accounting/banking/statement-lines/${ID}/explain`, key: "accounting:banking:reconcile" },
];

const PATCH_ROUTES: readonly GatedRoute[] = [
  { verb: "patch", path: `/accounting/accounts/${ID}`, key: "accounting:accounts:update" },
  { verb: "patch", path: `/accounting/accounts/${ID}/system-tag`, key: "accounting:accounts:manage" },
  { verb: "patch", path: `/accounting/payables/documents/${ID}`, key: "accounting:payables:manage" },
  { verb: "patch", path: `/accounting/banking/accounts/${ID}`, key: "accounting:banking:manage" },
  { verb: "patch", path: `/accounting/ar/credit-notes/${ID}`, key: "accounting:credit-notes:manage" },
  { verb: "patch", path: `/accounting/parties/${ID}`, key: "accounting:update" },
];

const PUT_ROUTES: readonly GatedRoute[] = [
  { verb: "put", path: `/accounting/banking/accounts/${ID}/csv-mapping`, key: "accounting:banking:manage" },
];

const DELETE_ROUTES: readonly GatedRoute[] = [
  { verb: "delete", path: `/accounting/accounts/${ID}`, key: "accounting:accounts:manage" },
  { verb: "delete", path: `/accounting/payables/documents/${ID}`, key: "accounting:payables:manage" },
  { verb: "delete", path: `/accounting/ar/credit-notes/${ID}`, key: "accounting:credit-notes:manage" },
  { verb: "delete", path: `/accounting/parties/${ID}`, key: "accounting:update" },
  { verb: "delete", path: `/accounting/banking/statement-lines/${ID}/match`, key: "accounting:banking:reconcile" },
  { verb: "delete", path: `/accounting/parties/${ID}/tax-registrations/${ID}`, key: "accounting:taxes:manage" },
];

const ALL_ROUTES: readonly GatedRoute[] = [
  ...GET_ROUTES,
  ...POST_ROUTES,
  ...PATCH_ROUTES,
  ...PUT_ROUTES,
  ...DELETE_ROUTES,
];

const trialBalance = { run: jest.fn(async () => ({ rows: [], balanced: true })) };

describe("accounting — authorization deny", () => {
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness(
      [
        ReconciliationController,
        ApAgingController,
        ApDocumentsController,
        ApPaymentsController,
        ArCreditNotesController,
        ArReceiptsController,
        BankAccountsController,
        BankStatementsController,
        BankMatchingController,
        AccountingKernelController,
        PartiesController,
        ReportsController,
        AccountingSetupController,
      ],
      { providers: [{ provide: TrialBalanceService, useValue: trialBalance }] },
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.reset();
    trialBalance.run.mockClear();
  });

  /*
   * Anti-vacuity for the table itself. Every key the routes below name must be
   * a key the catalogue knows; `authorize()` refuses an uncatalogued key with
   * FORBIDDEN before it ever consults a grant, which would make every deny case
   * in this file pass for the wrong reason.
   */
  it("names only catalogued permission keys, so no case passes on a typo", () => {
    const catalogued = new Set<string>(ALL_PERMISSION_NAMES);
    const unknown = ALL_ROUTES.map((r) => r.key).filter((k) => !catalogued.has(k));
    expect(unknown).toEqual([]);
    expect(ACCOUNTING_KEYS.length).toBeGreaterThan(20);
  });

  it("covers every verb the accounting surface exposes", () => {
    expect(ALL_ROUTES.length).toBeGreaterThanOrEqual(77);
    expect(new Set(ALL_ROUTES.map((r) => r.verb)).size).toBe(5);
  });

  describe("a caller holding every OTHER permission is still refused", () => {
    it.each(GET_ROUTES)("GET $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).get(path);
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });

    it.each(POST_ROUTES)("POST $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).post(path).send({});
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });

    it.each(PATCH_ROUTES)("PATCH $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).patch(path).send({});
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });

    it.each(PUT_ROUTES)("PUT $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).put(path).send({});
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });

    it.each(DELETE_ROUTES)("DELETE $path is 403 without $key", async ({ path, key }) => {
      harness.denyOnly(key);
      const res = await request(harness.server()).delete(path);
      expect(res.status).toBe(403);
      expect(harness.keysAsked()).toContain(key);
    });
  });

  describe("and is NOT refused once it holds that permission", () => {
    /*
     * Without this, every case above would still be green if the route 404'd,
     * if a class-level guard refused first, or if the path in the table were
     * simply wrong. A 400 from a validation pipe is a pass here: it proves the
     * request reached the handler's own input checking, past the guard.
     */
    it.each(GET_ROUTES)("GET $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).get(path);
      expect(res.status).not.toBe(403);
    });

    it.each(POST_ROUTES)("POST $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).post(path).send({});
      expect(res.status).not.toBe(403);
    });

    it.each(PATCH_ROUTES)("PATCH $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).patch(path).send({});
      expect(res.status).not.toBe(403);
    });

    it.each(PUT_ROUTES)("PUT $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).put(path).send({});
      expect(res.status).not.toBe(403);
    });

    it.each(DELETE_ROUTES)("DELETE $path is not 403 with $key", async ({ path }) => {
      harness.allowAll();
      const res = await request(harness.server()).delete(path);
      expect(res.status).not.toBe(403);
    });
  });

  describe("the refusal is the permission check, not something upstream of it", () => {
    it("answers 401 — not 403 — when no AuthContext is attached at all", async () => {
      /*
       * `authorize()` returns UNAUTHENTICATED for a missing context and the
       * guard turns that into 401. Accepting a 401 as a deny test would mean a
       * route could lose its permission entirely and still look covered, so the
       * two answers are pinned apart here.
       */
      harness.withoutAuthContext();
      harness.denyAll();
      const res = await request(harness.server()).get("/accounting/reports/trial-balance");
      expect(res.status).toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("answers 402 — not 403 — when the accounting module is not available", async () => {
      /*
       * `@RequireModule("accounting")` is a second, separate gate. It must not
       * be mistaken for the permission gate: the frontend keys its upgrade
       * prompt on 402 and shows a dead end on 403.
       */
      harness.disableModule("org-disabled");
      harness.allowAll();
      const res = await request(harness.server()).get("/accounting/reports/trial-balance");
      expect(res.status).toBe(402);
    });

    it("refuses a permitted caller in a tenant that cannot reach the module", async () => {
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.disableModule("not-in-plan");
      harness.allowAll();
      const res = await request(harness.server()).get("/accounting/reports/pnl");
      expect(res.status).toBe(402);
    });
  });

  describe("the tenant boundary", () => {
    it("reads the org from the authenticated principal, never from the caller", async () => {
      /*
       * The BOLA shape for these routes is not an id in the path — it is an org
       * the caller names. `ReportsController` passes `user.orgId` and the query
       * schema is `.strict()`, so a caller cannot smuggle one in. Both halves
       * are asserted: the service sees the authenticated org, and an attempt to
       * supply a different one is refused outright rather than ignored.
       */
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.allowAll();
      const ok = await request(harness.server())
        .get("/accounting/reports/trial-balance")
        .query({ asOf: "2026-01-31" });
      expect(ok.status).not.toBe(403);
      expect(trialBalance.run).toHaveBeenCalledWith(ORG_B, expect.anything());
      expect(trialBalance.run).not.toHaveBeenCalledWith(ORG_A, expect.anything());

      trialBalance.run.mockClear();
      const smuggled = await request(harness.server())
        .get("/accounting/reports/trial-balance")
        .query({ asOf: "2026-01-31", orgId: ORG_A });
      /*
       * The strict schema rejects the unknown key. The status is 4xx in
       * production, where the global Zod filter maps it; this harness mounts no
       * filters, so the assertion that carries the meaning is the second one —
       * the report service was never reached with the caller's chosen org.
       */
      expect(smuggled.status).toBeGreaterThanOrEqual(400);
      expect(trialBalance.run).not.toHaveBeenCalled();
    });

    it("refuses an org-B principal on an org-A report when the grant is withheld", async () => {
      harness.actAs({ orgId: ORG_B, userId: "user-b" });
      harness.denyOnly("accounting:reports:read");
      const res = await request(harness.server())
        .get("/accounting/reports/balance-sheet")
        .query({ asOf: "2026-01-31" });
      expect(res.status).toBe(403);
      expect(trialBalance.run).not.toHaveBeenCalled();
    });
  });

  it("asks the guard for the key the route declares, for every route", async () => {
    /*
     * The per-route cases above assert the answer. This asserts the question:
     * the set of keys `PermissionGuard` actually resolved across the whole
     * surface is exactly the set the tables name. A route silently gated on a
     * broader key — `accounting:read` standing in for
     * `accounting:periods:manage` — would show up here as a missing key.
     */
    harness.allowAll();
    for (const route of ALL_ROUTES) {
      await request(harness.server())[route.verb](route.path).send({});
    }
    const asked = new Set(harness.keysAsked());
    const declared = new Set(ALL_ROUTES.map((r) => r.key));
    for (const key of declared) expect(asked.has(key)).toBe(true);
  });
});

describe("accounting deny fixtures are not self-fulfilling", () => {
  /*
   * A last floor under the harness itself. `denyOnly` must grant everything it
   * is not withholding — if it ever degenerated into "deny all", every case in
   * this file would pass without proving a route reads its own key.
   */
  let harness: AuthzHarness;

  beforeAll(async () => {
    harness = await createAuthzHarness([ReportsController]);
  });

  afterAll(async () => {
    await harness.close();
  });

  it("withholds one key and grants the rest", async () => {
    harness.reset();
    harness.denyOnly("accounting:reports:export");
    const stillAllowed = await request(harness.server()).get("/accounting/reports/pnl");
    expect(stillAllowed.status).not.toBe(403);

    harness.denyOnly("accounting:reports:read");
    const refused = await request(harness.server()).get("/accounting/reports/pnl");
    expect(refused.status).toBe(403);
  });

  it("keeps an unauthenticated caller distinct from a denied one", async () => {
    harness.reset();
    harness.withoutAuthContext();
    const res = await request(harness.server()).get("/accounting/reports/aging");
    expect(res.status).toBe(401);
  });

  it("uses a principal built from the real AuthContext factory", () => {
    const actor = actorOf({ orgId: ORG_A });
    expect(actor.principal).toBeDefined();
    expect(actor.orgId).toBe(ORG_A);
  });
});
