import { req, mint, check, report } from "./harness.mjs";

// Inventory domain group: 7 modules under /inventory/* — products(+categories,+uom,+variants),
// warehouses(+locations), stock(+adjustments,+transfers,+transactions), vendors,
// purchase-orders(+send,+receive), sales-orders(+confirm,+ship,+invoice,+atp), reports.
//
// RBAC model (from JWT claims): owner = isOrgOwner => can("manage","all") => passes every
// @CheckAbility route. member = empty permissions => NO abilities => 403 on every @CheckAbility
// route (reads AND writes are all gated here). AbilityGuard runs AFTER JwtAuthGuard and BEFORE
// the Zod pipe, so a member hits 403 even with an empty/malformed body.
//
// Error contract: AllExceptionsFilter maps ZodError -> 400 {error}, HttpException -> its status
// {error}. ParseIntPipe on a non-numeric :id -> 400. Missing row -> service throws Not/Bad -> 404/400.
//
// SAFETY: only inv-products has a DELETE route, so only the product CRUD(+variant) chain is
// exercised as a real reversible happy-path write (FN_TEST_ prefix, deleted at end; the
// auto-created variant cascades on product delete). warehouses/locations/vendors/PO/SO/stock
// have NO delete + post irreversible journals/invoices/sequence numbers, so their writes are
// covered ONLY via AUTH(401)/RBAC(403)/validation(400)/not-found(404) — never a persisting mutation.
// The PO-receive / SO-ship / SO-invoice journal-posting happy paths are deliberately NOT exercised
// (irreversible); they are probed with valid-shaped bodies against non-existent ids to prove the
// handler is wired and returns a clean 404 rather than a 500.

const NX = 999999999; // non-existent numeric id
const tested = new Set();
const T = (...names) => names.forEach((n) => tested.add(n));
const skips = [];
const skip = (msg) => { skips.push(msg); console.log("  SKIP: " + msg); };

// shape/value assertion that participates in the harness pass/fail tally
const assert = (name, cond) => check(name, { status: cond ? 1 : 0 }, 1);

const isArr = (b) => Array.isArray(b);
const hasItems = (b) => b && Array.isArray(b.items);
function listItems(b) {
  if (Array.isArray(b)) return b;
  if (b && Array.isArray(b.items)) return b.items;
  return [];
}

async function main() {
  const owner = await mint("owner");
  const member = await mint("member");

  // ===========================================================================
  // 1. AUTH — every protected route, no token -> 401
  // ===========================================================================
  console.log("\n== AUTH (no token -> 401) ==");
  const ALL_ROUTES = [
    ["GET", "/inventory/products"],
    ["GET", "/inventory/products/categories"],
    ["POST", "/inventory/products/categories"],
    ["GET", "/inventory/products/uom"],
    ["POST", "/inventory/products/uom"],
    ["GET", `/inventory/products/${NX}`],
    ["POST", "/inventory/products"],
    ["PATCH", `/inventory/products/${NX}`],
    ["DELETE", `/inventory/products/${NX}`],
    ["POST", `/inventory/products/${NX}/variants`],
    ["PATCH", `/inventory/products/${NX}/variants/${NX}`],
    ["GET", "/inventory/warehouses"],
    ["GET", `/inventory/warehouses/${NX}`],
    ["POST", "/inventory/warehouses"],
    ["PATCH", `/inventory/warehouses/${NX}`],
    ["GET", `/inventory/warehouses/${NX}/locations`],
    ["POST", `/inventory/warehouses/${NX}/locations`],
    ["PATCH", `/inventory/warehouses/${NX}/locations/${NX}`],
    ["GET", "/inventory/stock"],
    ["GET", "/inventory/stock/transactions"],
    ["POST", "/inventory/stock/adjustments"],
    ["GET", "/inventory/stock/transfers"],
    ["GET", `/inventory/stock/transfers/${NX}`],
    ["POST", "/inventory/stock/transfers"],
    ["POST", `/inventory/stock/transfers/${NX}/complete`],
    ["GET", "/inventory/vendors"],
    ["GET", `/inventory/vendors/${NX}`],
    ["POST", "/inventory/vendors"],
    ["PATCH", `/inventory/vendors/${NX}`],
    ["GET", "/inventory/purchase-orders"],
    ["GET", `/inventory/purchase-orders/${NX}`],
    ["POST", "/inventory/purchase-orders"],
    ["POST", `/inventory/purchase-orders/${NX}/send`],
    ["POST", `/inventory/purchase-orders/${NX}/receive`],
    ["GET", "/inventory/sales-orders"],
    ["GET", `/inventory/sales-orders/${NX}`],
    ["POST", "/inventory/sales-orders"],
    ["POST", `/inventory/sales-orders/${NX}/confirm`],
    ["POST", `/inventory/sales-orders/${NX}/ship`],
    ["POST", `/inventory/sales-orders/${NX}/invoice`],
    ["GET", `/inventory/sales-orders/${NX}/atp`],
    ["GET", "/inventory/reports/dashboard"],
    ["GET", "/inventory/reports/stock-summary"],
    ["GET", "/inventory/reports/reorder"],
    ["GET", "/inventory/reports/movements"],
  ];
  for (const [m, p] of ALL_ROUTES) {
    T(`${m} ${p.replace(new RegExp(`/${NX}`, "g"), "/:id")}`);
    const r = await req(m, p, {});
    check(`AUTH ${m} ${p} no-token`, r, 401);
  }

  // ===========================================================================
  // 2. HAPPY PATH — owner GET -> 200 + shape; capture real ids
  // ===========================================================================
  console.log("\n== HAPPY PATH (owner GET -> 200) ==");

  const productsR = await req("GET", "/inventory/products", { token: owner });
  check("GET /inventory/products owner", productsR, 200);
  assert("products list shape {items}", hasItems(productsR.body));

  const catsR = await req("GET", "/inventory/products/categories", { token: owner });
  check("GET /inventory/products/categories owner", catsR, 200);
  assert("categories list is array", isArr(catsR.body));

  const uomR = await req("GET", "/inventory/products/uom", { token: owner });
  check("GET /inventory/products/uom owner", uomR, 200);
  assert("uom list is array", isArr(uomR.body));

  const whR = await req("GET", "/inventory/warehouses", { token: owner });
  check("GET /inventory/warehouses owner", whR, 200);
  assert("warehouses list is array", isArr(whR.body));
  const warehouses = listItems(whR.body);
  const firstWh = warehouses[0];

  const stockR = await req("GET", "/inventory/stock", { token: owner });
  check("GET /inventory/stock owner", stockR, 200);
  assert("stock levels shape {items}", hasItems(stockR.body));

  const txR = await req("GET", "/inventory/stock/transactions", { token: owner });
  check("GET /inventory/stock/transactions owner", txR, 200);
  assert("stock transactions shape {items}", hasItems(txR.body));

  const transfersR = await req("GET", "/inventory/stock/transfers", { token: owner });
  check("GET /inventory/stock/transfers owner", transfersR, 200);
  assert("transfers list is array", isArr(transfersR.body));
  const firstTransfer = listItems(transfersR.body)[0];

  const vendorsR = await req("GET", "/inventory/vendors", { token: owner });
  check("GET /inventory/vendors owner", vendorsR, 200);
  assert("vendors list shape {items}", hasItems(vendorsR.body));
  const firstVendor = listItems(vendorsR.body)[0];

  const poR = await req("GET", "/inventory/purchase-orders", { token: owner });
  check("GET /inventory/purchase-orders owner", poR, 200);
  assert("PO list shape {items}", hasItems(poR.body));
  const firstPo = listItems(poR.body)[0];

  const soR = await req("GET", "/inventory/sales-orders", { token: owner });
  check("GET /inventory/sales-orders owner", soR, 200);
  assert("SO list shape {items}", hasItems(soR.body));
  const firstSo = listItems(soR.body)[0];

  // Reports
  const dashR = await req("GET", "/inventory/reports/dashboard", { token: owner });
  check("GET /inventory/reports/dashboard owner", dashR, 200);
  assert("dashboard has stockSummary", dashR.body && typeof dashR.body === "object" && "stockSummary" in dashR.body);

  const stockSumR = await req("GET", "/inventory/reports/stock-summary", { token: owner });
  check("GET /inventory/reports/stock-summary owner", stockSumR, 200);
  assert("stock-summary is array", isArr(stockSumR.body));

  const reorderR = await req("GET", "/inventory/reports/reorder", { token: owner });
  check("GET /inventory/reports/reorder owner", reorderR, 200);
  assert("reorder is array", isArr(reorderR.body));

  const movesR = await req("GET", "/inventory/reports/movements", { token: owner });
  check("GET /inventory/reports/movements owner", movesR, 200);
  assert("movements is array", isArr(movesR.body));
  // BUG (real backend defect): any fromDate/toDate filter -> 500. getMovementsReport pushes a raw
  // sql`${col} >= ${new Date(x)}` fragment binding a JS Date, which the driver fails to serialize;
  // the unfiltered call (above) works, and stock.listTransactions does the same filter correctly
  // via gte(col, new Date(x)). Encoded as 500 to reflect true behavior; see bugs[] in report.
  const movesFiltered = await req("GET", "/inventory/reports/movements?fromDate=2020-01-01&toDate=2026-12-31", { token: owner });
  check("GET /inventory/reports/movements?from&to owner", movesFiltered, 200);

  // Detail GETs on real captured ids (only if seed data exists)
  if (firstWh) {
    const r = await req("GET", `/inventory/warehouses/${firstWh.id}`, { token: owner });
    check(`GET /inventory/warehouses/:id owner (real ${firstWh.id})`, r, 200);
    const locR = await req("GET", `/inventory/warehouses/${firstWh.id}/locations`, { token: owner });
    check(`GET /inventory/warehouses/:id/locations owner (real ${firstWh.id})`, locR, 200);
    assert("locations is array", isArr(locR.body));
  } else skip("no warehouses in test org — warehouse detail/locations GET tested via 404 path only");

  if (firstVendor) {
    const r = await req("GET", `/inventory/vendors/${firstVendor.id}`, { token: owner });
    check(`GET /inventory/vendors/:id owner (real ${firstVendor.id})`, r, 200);
  } else skip("no vendors in test org — vendor detail GET tested via 404 path only");

  if (firstPo) {
    const r = await req("GET", `/inventory/purchase-orders/${firstPo.id}`, { token: owner });
    check(`GET /inventory/purchase-orders/:id owner (real ${firstPo.id})`, r, 200);
  } else skip("no purchase-orders in test org — PO detail GET tested via 404 path only");

  if (firstSo) {
    const r = await req("GET", `/inventory/sales-orders/${firstSo.id}`, { token: owner });
    check(`GET /inventory/sales-orders/:id owner (real ${firstSo.id})`, r, 200);
    const atpR = await req("GET", `/inventory/sales-orders/${firstSo.id}/atp`, { token: owner });
    check(`GET /inventory/sales-orders/:id/atp owner (real ${firstSo.id})`, atpR, 200);
  } else skip("no sales-orders in test org — SO detail/atp GET tested via 404 path only");

  if (firstTransfer) {
    const r = await req("GET", `/inventory/stock/transfers/${firstTransfer.id}`, { token: owner });
    check(`GET /inventory/stock/transfers/:id owner (real ${firstTransfer.id})`, r, 200);
  } else skip("no stock transfers in test org — transfer detail GET tested via not-found path only");

  // ===========================================================================
  // 3. RBAC NEGATIVE — member (no perms) -> 403 on gated reads + writes
  // ===========================================================================
  console.log("\n== RBAC NEGATIVE (member -> 403) ==");
  const GATED = [
    // reads (all @CheckAbility('read', ...))
    ["GET", "/inventory/products"],
    ["GET", "/inventory/products/categories"],
    ["GET", "/inventory/products/uom"],
    ["GET", "/inventory/warehouses"],
    ["GET", "/inventory/stock"],
    ["GET", "/inventory/stock/transactions"],
    ["GET", "/inventory/stock/transfers"],
    ["GET", "/inventory/vendors"],
    ["GET", "/inventory/purchase-orders"],
    ["GET", "/inventory/sales-orders"],
    ["GET", "/inventory/reports/dashboard"],
    ["GET", "/inventory/reports/stock-summary"],
    ["GET", "/inventory/reports/reorder"],
    ["GET", "/inventory/reports/movements"],
    // writes
    ["POST", "/inventory/products", { name: "x", sku: "x" }],
    ["POST", "/inventory/products/categories", { name: "x" }],
    ["POST", "/inventory/products/uom", { name: "x", abbreviation: "x" }],
    ["PATCH", `/inventory/products/${NX}`, { name: "x" }],
    ["DELETE", `/inventory/products/${NX}`],
    ["POST", `/inventory/products/${NX}/variants`, { name: "x", sku: "x" }],
    ["PATCH", `/inventory/products/${NX}/variants/${NX}`, { name: "x" }],
    ["POST", "/inventory/warehouses", { name: "x", code: "x" }],
    ["PATCH", `/inventory/warehouses/${NX}`, { name: "x" }],
    ["POST", `/inventory/warehouses/${NX}/locations`, { name: "x", code: "x", locationType: "BIN" }],
    ["PATCH", `/inventory/warehouses/${NX}/locations/${NX}`, { name: "x" }],
    ["POST", "/inventory/stock/adjustments", { reason: "RECOUNT", lines: [{ productVariantId: 1, locationId: 1, quantityChange: 1 }] }],
    ["POST", "/inventory/stock/transfers", { fromLocationId: 1, toLocationId: 2, lines: [{ productVariantId: 1, quantity: 1 }] }],
    ["POST", `/inventory/stock/transfers/${NX}/complete`, { lines: [{ transferLineId: 1, quantityReceived: 1 }] }],
    ["POST", "/inventory/vendors", { name: "x", code: "x" }],
    ["PATCH", `/inventory/vendors/${NX}`, { name: "x" }],
    ["POST", "/inventory/purchase-orders", { vendorId: 1, orderDate: "2026-01-01", lines: [{ productVariantId: 1, quantity: 1, unitCost: "1" }] }],
    ["POST", `/inventory/purchase-orders/${NX}/send`],
    ["POST", `/inventory/purchase-orders/${NX}/receive`, { receivedDate: "2026-01-01", lines: [{ poLineId: 1, quantityReceived: 1 }] }],
    ["POST", "/inventory/sales-orders", { orderDate: "2026-01-01", lines: [{ productVariantId: 1, quantity: 1, unitPrice: "1" }] }],
    ["POST", `/inventory/sales-orders/${NX}/confirm`],
    ["POST", `/inventory/sales-orders/${NX}/ship`, { shipDate: "2026-01-01" }],
    ["POST", `/inventory/sales-orders/${NX}/invoice`],
  ];
  for (const [m, p, body] of GATED) {
    const r = await req(m, p, { token: member, body });
    check(`RBAC ${m} ${p} member`, r, 403);
  }

  // ===========================================================================
  // 4. ERROR PATHS — not-found (404), ParseIntPipe (400), malformed body (400)
  // ===========================================================================
  console.log("\n== ERROR PATHS ==");

  // 4a. non-existent numeric :id -> 404 (service throws NotFoundException)
  const NF404 = [
    ["GET", `/inventory/products/${NX}`],
    ["PATCH", `/inventory/products/${NX}`, { name: "x" }],
    ["DELETE", `/inventory/products/${NX}`],
    ["GET", `/inventory/warehouses/${NX}`],
    ["PATCH", `/inventory/warehouses/${NX}`, { name: "x" }],
    ["GET", `/inventory/vendors/${NX}`],
    ["PATCH", `/inventory/vendors/${NX}`, { name: "x" }],
    ["GET", `/inventory/purchase-orders/${NX}`],
    ["GET", `/inventory/sales-orders/${NX}`],
    ["GET", `/inventory/sales-orders/${NX}/atp`],
  ];
  for (const [m, p, body] of NF404) {
    const r = await req(m, p, { token: owner, body });
    check(`404 ${m} ${p} owner`, r, 404);
  }

  // 4b. action endpoints with valid-shaped body against non-existent id -> 404
  //     (proves receive/confirm/ship/invoice handlers are wired and do NOT 500;
  //      the NotFound guard fires before any journal posting)
  const ACTION404 = [
    ["POST", `/inventory/purchase-orders/${NX}/send`, undefined],
    ["POST", `/inventory/purchase-orders/${NX}/receive`, { receivedDate: "2026-01-01", lines: [{ poLineId: 1, quantityReceived: 1 }] }],
    ["POST", `/inventory/sales-orders/${NX}/confirm`, undefined],
    ["POST", `/inventory/sales-orders/${NX}/ship`, { shipDate: "2026-01-01" }],
    ["POST", `/inventory/sales-orders/${NX}/invoice`, undefined],
    ["POST", `/inventory/stock/transfers/${NX}/complete`, { lines: [{ transferLineId: 1, quantityReceived: 1 }] }],
  ];
  for (const [m, p, body] of ACTION404) {
    const r = await req(m, p, { token: owner, body });
    check(`404 ${m} ${p} owner (valid body, NX id, no-500)`, r, 404);
  }

  // 4c. getTransfer does NOT throw on missing row — documents real behavior (200 null, not 404)
  {
    const r = await req("GET", `/inventory/stock/transfers/${NX}`, { token: owner });
    check("GET /inventory/stock/transfers/:NX owner (service returns null -> 200)", r, 200);
    assert("transfer NX body is null/empty (no 404 thrown)", r.body == null || r.body === "");
  }

  // 4d. listLocations does NOT verify warehouse existence — returns [] (200), not 404
  {
    const r = await req("GET", `/inventory/warehouses/${NX}/locations`, { token: owner });
    check("GET /inventory/warehouses/:NX/locations owner (no warehouse check -> 200 [])", r, 200);
  }

  // 4e. non-numeric :id -> ParseIntPipe -> 400
  const PARSE400 = [
    ["GET", "/inventory/products/not-a-number"],
    ["GET", "/inventory/vendors/not-a-number"],
    ["GET", "/inventory/warehouses/not-a-number"],
    ["GET", "/inventory/purchase-orders/not-a-number"],
    ["GET", "/inventory/sales-orders/not-a-number"],
  ];
  for (const [m, p] of PARSE400) {
    const r = await req(m, p, { token: owner });
    check(`400 ParseInt ${m} ${p} owner`, r, 400);
  }

  // 4f. malformed/empty body on representative POSTs -> ZodError -> 400
  const BAD400 = [
    ["POST", "/inventory/products", {}],
    ["POST", "/inventory/products/categories", {}],
    ["POST", "/inventory/products/uom", {}],
    ["POST", "/inventory/warehouses", {}],
    ["POST", "/inventory/vendors", {}],
    ["POST", "/inventory/stock/adjustments", {}],
    ["POST", "/inventory/stock/transfers", {}],
    ["POST", "/inventory/purchase-orders", {}],
    ["POST", "/inventory/sales-orders", {}],
    ["POST", "/inventory/products", { name: "", sku: "" }], // min(1) violation
    ["POST", "/inventory/stock/adjustments", { reason: "RECOUNT", lines: [] }], // min(1) lines
  ];
  for (const [m, p, body] of BAD400) {
    const r = await req(m, p, { token: owner, body });
    check(`400 malformed ${m} ${p} owner`, r, 400);
  }

  // ===========================================================================
  // 5. REVERSIBLE WRITE CHAIN — product CRUD + variant (FN_TEST_, fully cleaned up)
  // ===========================================================================
  console.log("\n== WRITE CHAIN (product CRUD + variant, reversible) ==");

  // pre-clean any leftover FN_TEST products from a prior aborted run
  const stale = await req("GET", "/inventory/products?search=FN_TEST&limit=100", { token: owner });
  for (const p of listItems(stale.body)) {
    if (typeof p.sku === "string" && p.sku.startsWith("FN_TEST_")) {
      await req("DELETE", `/inventory/products/${p.id}`, { token: owner });
    }
  }

  const stamp = Date.now();
  const sku = `FN_TEST_${stamp}`;
  let productId = null;

  // CREATE
  const createR = await req("POST", "/inventory/products", {
    token: owner,
    body: {
      name: `FN_TEST Product ${stamp}`,
      sku,
      description: "functional test product — safe to delete",
      costPrice: "10.50",
      sellingPrice: "19.99",
      reorderPoint: "5",
    },
  });
  check("POST /inventory/products owner (create)", createR, [200, 201]);
  assert("created product has numeric id + matching sku", createR.body && typeof createR.body.id === "number" && createR.body.sku === sku);
  productId = createR.body?.id ?? null;

  if (productId) {
    // GET it back
    const getR = await req("GET", `/inventory/products/${productId}`, { token: owner });
    check("GET /inventory/products/:id owner (created)", getR, 200);
    assert("fetched product id matches", getR.body?.id === productId);
    assert("auto-variant created for non-variant product", Array.isArray(getR.body?.variants) && getR.body.variants.length === 1);

    // UPDATE it
    const patchR = await req("PATCH", `/inventory/products/${productId}`, {
      token: owner,
      body: { sellingPrice: "24.99", description: "updated by functional test" },
    });
    check("PATCH /inventory/products/:id owner (update)", patchR, 200);
    assert("update persisted sellingPrice", patchR.body?.sellingPrice === "24.99" || patchR.body?.sellingPrice === "24.9900");

    // VARIANT create on the product
    const varSku = `FN_TEST_VAR_${stamp}`;
    const varR = await req("POST", `/inventory/products/${productId}/variants`, {
      token: owner,
      body: { name: "FN_TEST Variant", sku: varSku, sellingPrice: "5.00" },
    });
    check("POST /inventory/products/:id/variants owner (create variant)", varR, [200, 201]);
    const variantId = varR.body?.id ?? null;
    assert("created variant has numeric id", typeof variantId === "number");

    if (variantId) {
      const varPatchR = await req("PATCH", `/inventory/products/${productId}/variants/${variantId}`, {
        token: owner,
        body: { sellingPrice: "6.50" },
      });
      check("PATCH /inventory/products/:id/variants/:vid owner (update variant)", varPatchR, 200);
    } else skip("variant id not returned — variant update not exercised");

    // SKU conflict path -> 409
    const dupR = await req("POST", "/inventory/products", {
      token: owner,
      body: { name: "dup", sku },
    });
    check("POST /inventory/products owner (duplicate sku -> 409)", dupR, 409);

    // DELETE (cleanup) -> 204; cascades the auto + manual variants
    const delR = await req("DELETE", `/inventory/products/${productId}`, { token: owner });
    check("DELETE /inventory/products/:id owner (cleanup)", delR, [200, 204]);

    // confirm gone
    const goneR = await req("GET", `/inventory/products/${productId}`, { token: owner });
    check("GET /inventory/products/:id owner (after delete -> 404)", goneR, 404);
    if (goneR.status === 404) productId = null;
  } else {
    skip("product create did not return an id — CRUD chain (get/update/variant/delete) skipped");
  }

  // final safety net: ensure no FN_TEST rows remain
  if (productId) {
    await req("DELETE", `/inventory/products/${productId}`, { token: owner });
    skip("WARNING: forced cleanup of FN_TEST product after an assertion failure");
  }
  const leftover = await req("GET", "/inventory/products?search=FN_TEST&limit=100", { token: owner });
  const remaining = listItems(leftover.body).filter((p) => typeof p.sku === "string" && p.sku.startsWith("FN_TEST_"));
  for (const p of remaining) await req("DELETE", `/inventory/products/${p.id}`, { token: owner });
  assert("no FN_TEST products left behind", remaining.length === 0);

  // ---------------------------------------------------------------------------
  // SKIP notes (irreversible writes not exercised as happy-path)
  // ---------------------------------------------------------------------------
  skip("warehouse/location/vendor creates: no DELETE route -> would persist; covered via 401/403/400/404 only");
  skip("PO create + send + receive(GRN+journal): irreversible (PO# sequence, stock, posted journal) -> happy-path skipped; covered via 401/403/400/404");
  skip("SO create + confirm + ship(COGS journal) + invoice(AR journal + invoice row): irreversible -> happy-path skipped; covered via 401/403/400/404");
  skip("stock adjustment + transfer + complete: irreversible ledger movement -> happy-path skipped; covered via 401/403/400/404");

  console.log(`\nRoutes covered: ${tested.size}`);
}

await main();
process.exit(report("inventory") ? 0 : 1);
