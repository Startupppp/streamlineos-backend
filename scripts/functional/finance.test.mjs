import { req, mint, check, report } from "./harness.mjs";

// Finance domain group: accounting (ledger/journal/post/reverse/statements/GST/AR-AP) + invoices.
// All routes are JwtAuthGuard-protected at controller level (no @Public).
// RBAC model: owner = isOrgOwner => can("manage","all"); member/salesRep have empty
// permissions => NO abilities => 403 on every @CheckAbility route. Auth-only routes
// (no @CheckAbility) must let a member through (200, or 404 for a missing row).
// NOTE: there are NO @Delete/@Put routes anywhere in these modules, so persisting
// creates cannot be undone via the API. Per the safety rule, real happy-path creates
// are SKIPPED (noted below); every write route is still exercised via AUTH (401),
// RBAC (403), validation (400) and not-found (404) paths, none of which mutate data.

const NX = 999999999; // non-existent numeric id
const DATE = { from: "2020-01-01", to: "2026-12-31", asOf: "2026-12-31" };

const tested = new Set();
const T = (name) => tested.add(name);
const skips = [];
const skip = (msg) => { skips.push(msg); console.log("  SKIP: " + msg); };

function listItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  return [];
}

async function main() {
  const owner = await mint("owner");
  const member = await mint("member");
  const salesRep = await mint("salesRep");

  // ---------------------------------------------------------------------------
  // AUTH: every protected route with NO token -> 401
  // ---------------------------------------------------------------------------
  const ALL_ROUTES = [
    ["GET", "/accounting/accounts"],
    ["POST", "/accounting/accounts"],
    ["PATCH", "/accounting/accounts/1"],
    ["GET", "/accounting/journal"],
    ["POST", "/accounting/journal"],
    ["GET", "/accounting/journal/1"],
    ["POST", "/accounting/journal/1/post"],
    ["POST", "/accounting/journal/1/reverse"],
    ["GET", "/accounting/reports/gstr-1"],
    ["GET", "/accounting/reports/gstr-3b"],
    ["GET", "/accounting/reports/trial-balance"],
    ["GET", "/accounting/reports/profit-loss"],
    ["GET", "/accounting/reports/balance-sheet"],
    ["GET", "/accounting/reports/cash-flow"],
    ["GET", "/accounting/purchase-bills"],
    ["POST", "/accounting/purchase-bills"],
    ["GET", "/accounting/purchase-bills/1"],
    ["PATCH", "/accounting/purchase-bills/1"],
    ["GET", "/accounting/purchase-bills/1/payments"],
    ["POST", "/accounting/purchase-bills/1/payments"],
    ["GET", "/accounting/vendors"],
    ["GET", "/accounting/vendors/1/ledger"],
    ["GET", "/accounting/customers"],
    ["GET", "/accounting/customers/1/ledger"],
    ["GET", "/accounting/reports/aged-receivables"],
    ["GET", "/accounting/reports/aged-payables"],
    ["GET", "/invoices"],
    ["GET", "/invoices/stats"],
    ["GET", "/invoices/recurring"],
    ["GET", "/invoices/1"],
    ["GET", "/invoices/1/payments"],
    ["POST", "/invoices"],
    ["POST", "/invoices/recurring/run"],
    ["PATCH", "/invoices/1"],
    ["POST", "/invoices/1/payments"],
  ];
  console.log("\n== AUTH (no token -> 401) ==");
  for (const [m, p] of ALL_ROUTES) {
    T(`${m} ${p.replace(/\/1(\/|$)/, "/:id$1")}`);
    const r = await req(m, p, {});
    check(`AUTH ${m} ${p} no-token`, r, 401);
  }

  // ---------------------------------------------------------------------------
  // HAPPY PATH: owner -> every GET 200; capture real ids for detail/sub-routes
  // ---------------------------------------------------------------------------
  console.log("\n== HAPPY PATH (owner GET -> 200) ==");

  const accountsR = await req("GET", "/accounting/accounts", { token: owner });
  check("GET /accounting/accounts owner", accountsR, 200);
  const accounts = listItems(accountsR.body);

  const journalR = await req("GET", "/accounting/journal", { token: owner });
  check("GET /accounting/journal owner", journalR, 200);
  const journalEntries = listItems(journalR.body);

  check("GET /accounting/reports/gstr-1 owner",
    await req("GET", `/accounting/reports/gstr-1?from=${DATE.from}&to=${DATE.to}`, { token: owner }), 200);
  check("GET /accounting/reports/gstr-3b owner",
    await req("GET", `/accounting/reports/gstr-3b?from=${DATE.from}&to=${DATE.to}`, { token: owner }), 200);
  check("GET /accounting/reports/trial-balance owner",
    await req("GET", `/accounting/reports/trial-balance?asOf=${DATE.asOf}`, { token: owner }), 200);
  // profit-loss & cash-flow share profitLossQuerySchema (from/to optional in Zod) but the
  // service requires both (throws 400 "from and to are required") — date range is mandatory.
  check("GET /accounting/reports/profit-loss owner",
    await req("GET", `/accounting/reports/profit-loss?from=${DATE.from}&to=${DATE.to}`, { token: owner }), 200);
  check("GET /accounting/reports/balance-sheet owner",
    await req("GET", `/accounting/reports/balance-sheet?asOf=${DATE.asOf}`, { token: owner }), 200);
  check("GET /accounting/reports/cash-flow owner",
    await req("GET", `/accounting/reports/cash-flow?from=${DATE.from}&to=${DATE.to}`, { token: owner }), 200);
  // service-level required-param guard (Zod allows omission, service rejects) -> 400
  check("GET /accounting/reports/profit-loss owner no-range -> 400",
    await req("GET", "/accounting/reports/profit-loss", { token: owner }), 400);
  check("GET /accounting/reports/cash-flow owner no-range -> 400",
    await req("GET", "/accounting/reports/cash-flow", { token: owner }), 400);
  check("GET /accounting/reports/aged-receivables owner",
    await req("GET", "/accounting/reports/aged-receivables", { token: owner }), 200);
  check("GET /accounting/reports/aged-payables owner",
    await req("GET", "/accounting/reports/aged-payables", { token: owner }), 200);

  const billsR = await req("GET", "/accounting/purchase-bills", { token: owner });
  check("GET /accounting/purchase-bills owner", billsR, 200);
  const bills = listItems(billsR.body);

  const vendorsR = await req("GET", "/accounting/vendors", { token: owner });
  check("GET /accounting/vendors owner", vendorsR, 200);
  const vendors = listItems(vendorsR.body);

  const customersR = await req("GET", "/accounting/customers", { token: owner });
  check("GET /accounting/customers owner", customersR, 200);
  const customers = listItems(customersR.body);

  const invoicesR = await req("GET", "/invoices", { token: owner });
  check("GET /invoices owner", invoicesR, 200);
  const invoices = listItems(invoicesR.body);

  check("GET /invoices/stats owner", await req("GET", "/invoices/stats", { token: owner }), 200);

  const recurringR = await req("GET", "/invoices/recurring", { token: owner });
  check("GET /invoices/recurring owner", recurringR, 200);
  const recurring = listItems(recurringR.body);

  // --- detail / sub-routes with real ids (or NX -> 404 when the table is empty) ---
  const journalId = journalEntries[0]?.id ?? null;
  if (journalId) check("GET /accounting/journal/:id owner",
    await req("GET", `/accounting/journal/${journalId}`, { token: owner }), 200);
  else { check("GET /accounting/journal/:id owner (no data -> 404)",
    await req("GET", `/accounting/journal/${NX}`, { token: owner }), 404);
    skip("no journal entries — detail asserted via 404 on non-existent id"); }

  const billId = bills[0]?.id ?? null;
  if (billId) {
    check("GET /accounting/purchase-bills/:id owner",
      await req("GET", `/accounting/purchase-bills/${billId}`, { token: owner }), 200);
    check("GET /accounting/purchase-bills/:id/payments owner",
      await req("GET", `/accounting/purchase-bills/${billId}/payments`, { token: owner }), 200);
  } else {
    check("GET /accounting/purchase-bills/:id owner (no data -> 404)",
      await req("GET", `/accounting/purchase-bills/${NX}`, { token: owner }), 404);
    check("GET /accounting/purchase-bills/:id/payments owner (no data -> 404)",
      await req("GET", `/accounting/purchase-bills/${NX}/payments`, { token: owner }), 404);
    skip("no purchase bills — bill detail/payments asserted via 404 on non-existent id");
  }

  const vendorId = vendors[0]?.vendorId ?? null;
  if (vendorId) check("GET /accounting/vendors/:id/ledger owner",
    await req("GET", `/accounting/vendors/${vendorId}/ledger`, { token: owner }), 200);
  else { check("GET /accounting/vendors/:id/ledger owner (no vendors -> 404)",
    await req("GET", `/accounting/vendors/${NX}/ledger`, { token: owner }), 404);
    skip("no vendors — vendor ledger asserted via 404 on non-existent id"); }

  const clientId = customers[0]?.clientId ?? null;
  if (clientId) check("GET /accounting/customers/:id/ledger owner",
    await req("GET", `/accounting/customers/${clientId}/ledger`, { token: owner }), 200);
  else { check("GET /accounting/customers/:id/ledger owner (no clients -> 404)",
    await req("GET", `/accounting/customers/${NX}/ledger`, { token: owner }), 404);
    skip("no clients — customer ledger asserted via 404 on non-existent id"); }

  const invoiceId = invoices[0]?.id ?? null;
  if (invoiceId) {
    check("GET /invoices/:id owner",
      await req("GET", `/invoices/${invoiceId}`, { token: owner }), 200);
    check("GET /invoices/:id/payments owner",
      await req("GET", `/invoices/${invoiceId}/payments`, { token: owner }), 200);
  } else {
    check("GET /invoices/:id owner (no data -> 404)",
      await req("GET", `/invoices/${NX}`, { token: owner }), 404);
    // payments sub-route has no existence check in the service -> returns [] (200) even for NX
    check("GET /invoices/:id/payments owner (no existence check -> 200 empty)",
      await req("GET", `/invoices/${NX}/payments`, { token: owner }), 200);
    skip("no invoices — invoice detail asserted via 404; payments returns empty 200 (no existence check)");
  }

  // ---------------------------------------------------------------------------
  // RBAC NEGATIVE: low-priv token on @CheckAbility routes -> 403
  // ---------------------------------------------------------------------------
  console.log("\n== RBAC NEGATIVE (low-priv -> 403 on @CheckAbility) ==");
  // Reads gated by CheckAbility
  check("RBAC GET /accounting/accounts member", await req("GET", "/accounting/accounts", { token: member }), 403);
  check("RBAC GET /accounting/journal member", await req("GET", "/accounting/journal", { token: member }), 403);
  check("RBAC GET /accounting/reports/trial-balance salesRep",
    await req("GET", `/accounting/reports/trial-balance?asOf=${DATE.asOf}`, { token: salesRep }), 403);
  check("RBAC GET /accounting/reports/gstr-1 member",
    await req("GET", `/accounting/reports/gstr-1?from=${DATE.from}&to=${DATE.to}`, { token: member }), 403);
  check("RBAC GET /accounting/purchase-bills member", await req("GET", "/accounting/purchase-bills", { token: member }), 403);
  check("RBAC GET /accounting/vendors member", await req("GET", "/accounting/vendors", { token: member }), 403);
  check("RBAC GET /accounting/customers member", await req("GET", "/accounting/customers", { token: member }), 403);
  check("RBAC GET /accounting/reports/aged-payables member", await req("GET", "/accounting/reports/aged-payables", { token: member }), 403);
  check("RBAC GET /invoices member", await req("GET", "/invoices", { token: member }), 403);
  // Writes gated by CheckAbility
  check("RBAC POST /accounting/accounts member", await req("POST", "/accounting/accounts", { token: member, body: {} }), 403);
  check("RBAC PATCH /accounting/accounts/:id member", await req("PATCH", `/accounting/accounts/${NX}`, { token: member, body: {} }), 403);
  check("RBAC POST /accounting/journal salesRep", await req("POST", "/accounting/journal", { token: salesRep, body: {} }), 403);
  check("RBAC POST /accounting/journal/:id/post member", await req("POST", `/accounting/journal/${NX}/post`, { token: member }), 403);
  check("RBAC POST /accounting/journal/:id/reverse member", await req("POST", `/accounting/journal/${NX}/reverse`, { token: member }), 403);
  check("RBAC POST /accounting/purchase-bills member", await req("POST", "/accounting/purchase-bills", { token: member, body: {} }), 403);
  check("RBAC PATCH /accounting/purchase-bills/:id member", await req("PATCH", `/accounting/purchase-bills/${NX}`, { token: member, body: {} }), 403);
  check("RBAC POST /accounting/purchase-bills/:id/payments member", await req("POST", `/accounting/purchase-bills/${NX}/payments`, { token: member, body: {} }), 403);
  check("RBAC POST /invoices salesRep", await req("POST", "/invoices", { token: salesRep, body: {} }), 403);

  // ---------------------------------------------------------------------------
  // AUTH-ONLY ROUTES NOT OVER-GATED: member must pass auth (200, or 404 for NX)
  // ---------------------------------------------------------------------------
  console.log("\n== AUTH-ONLY (member not over-gated) ==");
  check("AUTHONLY GET /invoices/stats member 200", await req("GET", "/invoices/stats", { token: member }), 200);
  check("AUTHONLY GET /invoices/recurring member 200", await req("GET", "/invoices/recurring", { token: member }), 200);
  {
    const id = invoiceId ?? NX;
    const exp = invoiceId ? 200 : 404; // either way: not 401/403
    check(`AUTHONLY GET /invoices/:id member ${exp}`, await req("GET", `/invoices/${id}`, { token: member }), exp);
  }
  check("AUTHONLY GET /invoices/:id/payments member 200",
    await req("GET", `/invoices/${invoiceId ?? NX}/payments`, { token: member }), 200);
  // PATCH/POST auth-only: reach handler then 404 on non-existent invoice (proves not 403/401)
  check("AUTHONLY PATCH /invoices/:id member -> 404 (reaches handler)",
    await req("PATCH", `/invoices/${NX}`, { token: member, body: { notes: "x" } }), 404);
  check("AUTHONLY POST /invoices/:id/payments member -> 404 (reaches handler)",
    await req("POST", `/invoices/${NX}/payments`, { token: member, body: { amount: 1, paymentDate: "2026-01-01", paymentMethod: "cash" } }), 404);
  // recurring/run is auth-only and side-effecting: only exercise the member 200 path
  // when there is nothing due (no-op), otherwise skip to avoid generating invoices.
  if (recurring.length === 0) {
    check("AUTHONLY POST /invoices/recurring/run member 200 (no due recurring -> no-op)",
      await req("POST", "/invoices/recurring/run", { token: member }), 200);
  } else {
    skip(`POST /invoices/recurring/run: ${recurring.length} recurring invoice(s) present — skipped to avoid generating real invoices (covered by 401 auth check only)`);
  }

  // ---------------------------------------------------------------------------
  // ERROR PATHS: bad :id (ParseIntPipe -> 400), non-existent -> 404, bad body -> 400
  // ---------------------------------------------------------------------------
  console.log("\n== ERROR PATHS ==");
  // non-numeric :id where ParseIntPipe applies -> 400
  check("ERR GET /accounting/journal/abc -> 400", await req("GET", "/accounting/journal/abc", { token: owner }), 400);
  check("ERR GET /accounting/purchase-bills/abc -> 400", await req("GET", "/accounting/purchase-bills/abc", { token: owner }), 400);
  check("ERR PATCH /accounting/accounts/abc -> 400", await req("PATCH", "/accounting/accounts/abc", { token: owner, body: { name: "x" } }), 400);
  check("ERR GET /invoices/abc -> 400", await req("GET", "/invoices/abc", { token: owner }), 400);

  // non-existent numeric :id -> 404 (non-mutating: handlers 404 before any write)
  check("ERR GET /accounting/journal/NX -> 404", await req("GET", `/accounting/journal/${NX}`, { token: owner }), 404);
  check("ERR POST /accounting/journal/NX/post -> 404", await req("POST", `/accounting/journal/${NX}/post`, { token: owner }), 404);
  check("ERR POST /accounting/journal/NX/reverse -> 404", await req("POST", `/accounting/journal/${NX}/reverse`, { token: owner }), 404);
  check("ERR GET /accounting/purchase-bills/NX -> 404", await req("GET", `/accounting/purchase-bills/${NX}`, { token: owner }), 404);
  check("ERR GET /accounting/purchase-bills/NX/payments -> 404", await req("GET", `/accounting/purchase-bills/${NX}/payments`, { token: owner }), 404);
  check("ERR PATCH /accounting/purchase-bills/NX -> 404", await req("PATCH", `/accounting/purchase-bills/${NX}`, { token: owner, body: { status: "CANCELLED" } }), 404);
  check("ERR POST /accounting/purchase-bills/NX/payments -> 404",
    await req("POST", `/accounting/purchase-bills/${NX}/payments`, { token: owner, body: { amount: 1, paymentDate: "2026-01-01", paymentMethod: "cash" } }), 404);
  check("ERR GET /accounting/vendors/NX/ledger -> 404", await req("GET", `/accounting/vendors/${NX}/ledger`, { token: owner }), 404);
  check("ERR GET /accounting/customers/NX/ledger -> 404", await req("GET", `/accounting/customers/${NX}/ledger`, { token: owner }), 404);
  check("ERR PATCH /accounting/accounts/NX -> 404", await req("PATCH", `/accounting/accounts/${NX}`, { token: owner, body: { name: "FN_TEST_x" } }), 404);
  check("ERR GET /invoices/NX -> 404", await req("GET", `/invoices/${NX}`, { token: owner }), 404);
  check("ERR PATCH /invoices/NX -> 404", await req("PATCH", `/invoices/${NX}`, { token: owner, body: { notes: "x" } }), 404);
  check("ERR POST /invoices/NX/payments -> 404",
    await req("POST", `/invoices/${NX}/payments`, { token: owner, body: { amount: 1, paymentDate: "2026-01-01", paymentMethod: "cash" } }), 404);

  // malformed / empty body on representative POST/PATCH -> 400 (Zod, before any insert)
  check("ERR POST /accounting/accounts {} -> 400", await req("POST", "/accounting/accounts", { token: owner, body: {} }), 400);
  check("ERR POST /accounting/journal {} -> 400", await req("POST", "/accounting/journal", { token: owner, body: {} }), 400);
  check("ERR POST /accounting/journal unbalanced -> 400", await req("POST", "/accounting/journal", {
    token: owner,
    body: { entryDate: "2026-01-01", description: "FN_TEST_unbalanced", lines: [
      { accountCode: "1000", debit: 100, credit: 0 },
      { accountCode: "2000", debit: 0, credit: 50 },
    ] },
  }), 400);
  check("ERR POST /accounting/purchase-bills {} -> 400", await req("POST", "/accounting/purchase-bills", { token: owner, body: {} }), 400);
  check("ERR POST /invoices {} -> 400", await req("POST", "/invoices", { token: owner, body: {} }), 400);
  check("ERR POST /invoices/NX/payments {} -> 400 (before 404)", await req("POST", `/invoices/${NX}/payments`, { token: owner, body: {} }), 400);

  // ---------------------------------------------------------------------------
  // WRITES (persisting happy path): SKIPPED — no DELETE/PUT route exists in these
  // modules, so created rows cannot be safely undone via the API.
  // ---------------------------------------------------------------------------
  skip("POST /accounting/accounts create: skipped (no delete route to undo FN_TEST_ account)");
  skip("POST /accounting/journal create: skipped (no delete route to undo journal entry)");
  skip("POST /accounting/journal/:id/post + /reverse happy path: skipped (depends on persisting a journal entry that cannot be deleted)");
  skip("POST /accounting/purchase-bills create + payments: skipped (no delete route to undo bill/payment)");
  skip("PATCH /accounting/accounts/:id + /accounting/purchase-bills/:id happy path: skipped (would irreversibly mutate real rows)");
  skip("POST /invoices create + PATCH /invoices/:id + POST /invoices/:id/payments happy path: skipped (no delete route to undo invoice/payment)");

  console.log(`\n[finance] distinct routes exercised: ${tested.size}`);
  process.exit(report("finance") ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
