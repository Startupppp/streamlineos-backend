import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * INV-22, the half that was never built.
 *
 * The ticket asks for a drift gate between what the API returns and the types
 * the frontend hooks consume it through. What shipped under that name is
 * `frontend/lib/rbac/permissions/__tests__/catalog-sync.test.ts`, which compares
 * 685 backend permission-key STRINGS against the 710 in the frontend union. That
 * is a real gate and it caught a real defect, but it compares NO field of NO
 * response: a service could drop a column, rename it, or change its grain from
 * `number` to a decimal string, and every permission key would still line up.
 * The frontend's own `check:contract-drift` is the closest thing to a shape
 * gate, and it reads `requestBody` schemas only, over `hooks/api/timesheets*`
 * only — zero inventory endpoints, and never a response.
 *
 * So the frontend's `LandedCostVoucherListItem` could keep compiling against a
 * `capitalisedValue` the service stopped selecting, and nothing anywhere would
 * say so. `tsc` cannot: `apiClient.get<T>()` is an assertion about a wire
 * payload, not a fact the compiler can check.
 *
 * **Why the shape comes from the service and not from OpenAPI.** Written when
 * `openapi.json` was unusable for this: of its 3,577 operations exactly ONE
 * declared a 2xx response schema, and of the 198 `/inventory` operations, ZERO
 * did — `@Validate({ body, query, params })` is a REQUEST contract, and the
 * response half of this API was simply not described.
 *
 * ⚠ **That is no longer true, as of the response-contract lane merged into
 * `main`:** 3,731 of 3,893 operations now declare a 2xx response schema, and so
 * do 391 of the 392 `/inventory` ones — the last being a `204`, which has no
 * body to describe. The canary at the bottom of this file asserted the zero and
 * now asserts the coverage, so this paragraph stays checkable rather than
 * remembered either way.
 *
 * It does not change what this gate compares. `openapi.json` is a statement of
 * the BACKEND's response shape; the drift that breaks a screen is between that
 * shape and the FRONTEND type a hook reads it through, and the frontend's types
 * are in neither the document nor the compiler's reach (`apiClient.get<T>()` is
 * an assertion about a wire payload, not a fact `tsc` can check). What is
 * declarative on the backend side is the service's own `.select({ ... })`
 * projection — a literal list of the exact keys that reach the wire, in one
 * place, enforced by Drizzle's types — and comparing it against the consuming
 * type is the half nothing else does. Comparing the projections against the new
 * `@ResponseSchema` declarations is a worthwhile second gate, and a different
 * one from this.
 */

/** `src/modules/inventory/__tests__` → the backend checkout root. */
const BACKEND_ROOT = resolve(__dirname, "..", "..", "..", "..");
const INVENTORY_DIR = resolve(__dirname, "..");

/**
 * The frontend checkout paired with this backend one.
 *
 * Mirrors `frontend/test-support/backend-checkout.ts`, deliberately and in the
 * same order, because that helper was written after the failure this must not
 * repeat: five cross-repo guards resolved a path that did not exist, returned
 * before asserting anything, and reported green forever. A sixth resolved a
 * path that existed but belonged to another branch, and confidently called 22
 * live permission keys phantoms.
 *
 * So the PAIRED worktree is tried first — `inv-wt-backend` pairs with
 * `inv-wt-frontend`, not with whatever `streamlineos-frontend` happens to be
 * checked out at — and a miss is a THROW, never a skip. There is no
 * `backendPath()` on this side of the wire to reuse: that helper lives in the
 * frontend repo, and this repo's own cross-repo resolver
 * (`src/scripts/check-permission-keys.mjs`) still assumes a `<repo>/frontend`
 * beside `<repo>/backend` layout that no worktree here has ever had.
 */
function frontendHooksDir(): { dir: string; tried: string[] } {
  const tried: string[] = [];

  const envFront = process.env.STREAMLINE_FRONTEND_ROOT || process.env.STREAMLINE_WORKSPACE_ROOT;
  if (envFront) {
    for (const nested of [".", "frontend"]) {
      const candidate = resolve(envFront, nested, "hooks", "api", "inventory");
      tried.push(candidate);
      if (existsSync(candidate)) return { dir: candidate, tried };
    }
  }

  const checkout = basename(BACKEND_ROOT);
  const paired = checkout.endsWith("-backend")
    ? `${checkout.slice(0, -"-backend".length)}-frontend`
    : null;
  const roots = [
    ...(paired === null ? [] : [paired]),
    "streamlineos-frontend",
    "tsign-frontend",
    "frontend",
  ];

  // Try child checkouts (inside BACKEND_ROOT, e.g. GITHUB_WORKSPACE/streamlineos-frontend)
  for (const root of roots) {
    for (const nested of ["frontend", "."]) {
      const dir = resolve(BACKEND_ROOT, root, nested, "hooks", "api", "inventory");
      tried.push(dir);
      if (existsSync(dir)) return { dir, tried };
    }
  }

  // Try sibling checkouts (beside BACKEND_ROOT)
  for (const root of roots) {
    for (const nested of ["frontend", "."]) {
      const dir = resolve(BACKEND_ROOT, "..", root, nested, "hooks", "api", "inventory");
      tried.push(dir);
      if (existsSync(dir)) return { dir, tried };
    }
  }

  throw new Error(
    `INV-22 shape gate: no frontend checkout found. A cross-repo gate that cannot find the frontend repo must FAIL, never skip. ` +
      `Ensure FRONTEND_REPO_TOKEN is configured in GitHub secrets so CI can check out Startupppp/streamlineos-frontend. Tried:\n  ${tried.join("\n  ")}`,
  );
}

const { dir: HOOKS_DIR } = frontendHooksDir();

interface Projection {
  table: string;
  keys: string[];
}

/** The index of the `}` closing the `{` at `open`. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The member names an object/interface body declares at its own level.
 *
 * Depth-tracked so a nested object type contributes its own name and not its
 * children's, and so a `sql<...>` template's braces do not leak keys.
 */
function membersOf(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    if (depth === 1) {
      const member = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(line.trim());
      if (member) keys.push(member[1]!);
    }
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
  }
  return keys;
}

/**
 * A file-level `const X = { … } as const` projection, by name.
 *
 * A service that reads one shape from three places names the columns once and
 * spreads the constant, which is the right thing to do — `export.service.ts`
 * drifted from its own frontend type precisely because it did not. But a spread
 * is opaque to a key scanner, so without this the DRY version of a projection
 * reads as an *empty* one and its pair silently covers nothing. Resolving it is
 * what lets this gate reward the better code instead of punishing it.
 *
 * One level, same file, no chained spreads: enough for the idiom in use, and it
 * stops here rather than growing into a resolver that quietly guesses.
 */
function constProjection(source: string, name: string): string[] | null {
  const declared = new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(source);
  if (declared === null) return null;
  const open = source.indexOf("{", declared.index);
  const close = closingBrace(source, open);
  if (close === -1) return null;
  return membersOf(source.slice(open, close + 1));
}

/**
 * Keys selected as a window function, which never reach the wire.
 *
 * `count(*) OVER ()` is how a paginated list gets its total in one pass, and
 * every such list strips the column before returning — `export.service.ts` does
 * it with `rows.map(({ windowTotal: _, ...rest }) => rest)`. Counting it as a
 * response field makes a list projection disagree with the detail projection of
 * the same shape by exactly one key, which reads as an ambiguous anchor and
 * fails for a reason that has nothing to do with drift. Four services here use
 * the idiom.
 */
function windowColumns(body: string): Set<string> {
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const member = /^([A-Za-z_$][\w$]*)\s*:/.exec(line.trim());
    if (member && /\bOVER\s*\(/.test(line)) names.add(member[1]!);
  }
  return names;
}

/** Every `.select({ … }).from(table)` in a service, with the table it reads. */
function projectionsIn(source: string): Projection[] {
  const found: Projection[] = [];
  const select = /\.select\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = select.exec(source)) !== null) {
    const open = source.indexOf("{", match.index);
    const close = closingBrace(source, open);
    if (close === -1) continue;
    const from = /^\s*\)\s*\.from\(\s*([A-Za-z_$][\w$]*)/.exec(source.slice(close + 1, close + 200));
    if (from === null) continue;
    const body = source.slice(open, close + 1);
    const keys = membersOf(body);
    /* `...SOME_CONST` inside the literal contributes that constant's own keys. */
    for (const spread of body.matchAll(/\.\.\.([A-Z][A-Z0-9_]*)\b/g)) {
      const resolved = constProjection(source, spread[1]!);
      if (resolved !== null) keys.push(...resolved);
    }
    found.push({ table: from[1]!, keys: keys.filter((key) => !windowColumns(body).has(key)) });
  }

  /**
   * `.returning({ … })` is a response shape too — a write path returns what it
   * just wrote, and nothing else here was reading those.
   *
   * **What this does not catch, stated plainly.** The defect that put the
   * export-jobs pair on this table was a *bare* `.returning()` — no object
   * literal — whose row was spread into the response. A bare call declares no
   * keys, so there is nothing here to compare and the pair silently falls back
   * to the `.select()` projections beside it, which were correct all along. I
   * added the pair, reverted the fix to check, and **the gate stayed green
   * twice**: once before this function existed and once after. Both times are
   * recorded because the second is the useful one — extending a gate is not the
   * same as extending its reach, and only trying to fool it tells you which you
   * did.
   *
   * So this catches a projection that has DRIFTED, never one that is ABSENT.
   * Absent is a different defect — a raw ORM row on the wire, which backend
   * §1 forbids outright — and it wants its own ratchet: there are 80 bare
   * `.returning()` calls under `src/modules/inventory` today, most of them
   * internal reads that are perfectly fine, so that gate is a triage job and not
   * a one-line rule.
   *
   * The table comes from the `.insert(x)` or `.update(x)` that opened the chain,
   * scanning backwards to the nearest one.
   */
  const returning = /\.returning\(\s*\{/g;
  let ret: RegExpExecArray | null;
  while ((ret = returning.exec(source)) !== null) {
    const open = source.indexOf("{", ret.index);
    const close = closingBrace(source, open);
    if (close === -1) continue;
    const before = source.slice(0, ret.index);
    const chain = /\.(?:insert|update)\(\s*([A-Za-z_$][\w$]*)\s*\)(?![\s\S]*\.(?:insert|update)\()/.exec(before);
    if (chain === null) continue;
    const body = source.slice(open, close + 1);
    const keys = membersOf(body);
    for (const spread of body.matchAll(/\.\.\.([A-Z][A-Z0-9_]*)\b/g)) {
      const resolved = constProjection(source, spread[1]!);
      if (resolved !== null) keys.push(...resolved);
    }
    found.push({ table: chain[1]!, keys: keys.filter((key) => !windowColumns(body).has(key)) });
  }

  return found;
}

/** The members of one exported interface, or `null` when it is gone. */
function interfaceMembers(source: string, name: string): string[] | null {
  const declared = new RegExp(`export interface ${name}\\s*(?:extends [^{]+)?\\{`).exec(source);
  if (declared === null) return null;
  const open = source.indexOf("{", declared.index);
  const close = closingBrace(source, open);
  if (close === -1) return null;
  return membersOf(source.slice(open, close + 1));
}

/** The members of a `const <contract> = z.object({ … })` in the same file. */
function zodContractMembers(source: string, contract: string): string[] | null {
  const declared = new RegExp(`const ${contract}\\s*=\\s*z\\.object\\(`).exec(source);
  if (declared === null) return null;
  const open = source.indexOf("{", declared.index);
  const close = closingBrace(source, open);
  if (close === -1) return null;
  return membersOf(source.slice(open, close + 1));
}

/**
 * The members of the type a hook consumes a response through, however it is
 * declared — or `null` when it is genuinely gone.
 *
 * A bare `export interface` is one of two forms in use. The other is a runtime
 * contract, `export type X = z.infer<typeof xContract>` over a `z.object`, which
 * is strictly the better of the two: it checks the payload at the boundary
 * instead of asserting it. `valuation.ts` moved `InventoryPeriod` onto one and
 * this gate read it as a DELETED type, which is the failure mode that punishes
 * the better code — the same one `constProjection` exists to avoid on the
 * backend side. A zod object's keys are as declarative as an interface's, so
 * both are read and the comparison below is unchanged.
 */
function typeMembers(source: string, name: string): string[] | null {
  const asInterface = interfaceMembers(source, name);
  if (asInterface !== null) return asInterface;
  const inferred = new RegExp(
    `export type ${name}\\s*=\\s*z\\.infer<\\s*typeof\\s+([A-Za-z_$][\\w$]*)\\s*>`,
  ).exec(source);
  if (inferred === null) return null;
  return zodContractMembers(source, inferred[1]!);
}

interface Pair {
  /** Controller file under `src/modules/inventory`, and the route it declares. */
  controller: string;
  prefix: string;
  verb: "Get" | "Post" | "Put" | "Patch" | "Delete";
  /** The route decorator's argument; `null` for a bare `@Get()`. */
  route: string | null;
  /** Service file under `src/modules/inventory`. */
  service: string;
  /** The table the projection reads, and a field that identifies it in that file. */
  table: string;
  anchor: string;
  /** Hook file under `hooks/api/inventory` that DECLARES the type. */
  hook: string;
  type: string;
  /**
   * Hook file that CALLS the endpoint, when the repo splits types from calls
   * (`*-types.ts`). Defaults to `hook`.
   */
  consumer?: string;
}

/**
 * The pairs, each one an endpoint whose response the named hook type describes.
 *
 * `anchor` is a field that identifies the projection within its file rather
 * than an ordinal, so inserting a query above it does not silently re-point the
 * pair at a different read. Every projection in that file over that table
 * carrying the anchor must agree on its whole key set, or the anchor has become
 * ambiguous and that is a failure of its own.
 */
const PAIRS: readonly Pair[] = [
  { controller: "channels/channel-snapshot.controller.ts", prefix: "inventory/channels", verb: "Get", route: ":channelId/snapshot-differences", service: "channels/lib/channel-snapshot-review.ts", table: "invChannelSnapshotDiffs", anchor: "externalSku", hook: "channels.ts", type: "ChannelSnapshotDiff" },
  { controller: "channels/quick-commerce/quick-commerce.controller.ts", prefix: "inventory/quick-commerce", verb: "Get", route: "purchase-orders", service: "channels/quick-commerce/quick-commerce-inbound.service.ts", table: "invPlatformPurchaseOrders", anchor: "providerPoNumber", hook: "quick-commerce.ts", type: "PlatformPoSummary" },
  { controller: "channels/quick-commerce/quick-commerce.controller.ts", prefix: "inventory/quick-commerce", verb: "Get", route: "asns", service: "channels/quick-commerce/quick-commerce-inbound.service.ts", table: "invAsns", anchor: "asnNumber", hook: "quick-commerce.ts", type: "AsnSummary" },
  { controller: "channels/pools/channel-pools.controller.ts", prefix: "inventory/channels/pools", verb: "Get", route: "channel/:channelId", service: "stock-engine/channel-pool.service.ts", table: "invChannelPools", anchor: "channelName", hook: "channel-pools.ts", type: "ChannelPool" },
  { controller: "dock/dock.controller.ts", prefix: "inventory/dock", verb: "Get", route: "appointments", service: "dock/dock.service.ts", table: "invDockAppointments", anchor: "doorCode", hook: "stock-types-dock.ts", type: "DockAppointment" },
  { controller: "handling-units/handling-units.controller.ts", prefix: "inventory/handling-units", verb: "Get", route: null, service: "handling-units/handling-unit.service.ts", table: "invHandlingUnits", anchor: "updatedAt", hook: "handling-units.ts", type: "HandlingUnitSummary" },
  { controller: "import-export/import.controller.ts", prefix: "inventory/import", verb: "Get", route: "staged/:jobId/errors", service: "import-export/staged-import.service.ts", table: "invImportRows", anchor: "rowNumber", hook: "staged-import.ts", type: "StagedImportRowError" },
  { controller: "kitting/kit.controller.ts", prefix: "inventory/kits", verb: "Get", route: ":kitVariantId/bom", service: "kitting/kit.service.ts", table: "invKitComponents", anchor: "quantityPer", hook: "stock-types-dock.ts", type: "KitComponent" },
  { controller: "landed-cost/landed-cost.controller.ts", prefix: "inventory/landed-cost", verb: "Get", route: null, service: "landed-cost/landed-cost.service.ts", table: "invLandedCostVouchers", anchor: "voucherNumber", hook: "landed-cost.ts", type: "LandedCostVoucherListItem" },
  { controller: "landed-cost/landed-cost.controller.ts", prefix: "inventory/landed-cost", verb: "Get", route: ":voucherId", service: "landed-cost/landed-cost.service.ts", table: "invLandedCostCharges", anchor: "chargeType", hook: "landed-cost.ts", type: "LandedCostCharge" },
  { controller: "landed-cost/landed-cost.controller.ts", prefix: "inventory/landed-cost", verb: "Get", route: ":voucherId", service: "landed-cost/landed-cost.service.ts", table: "invLandedCostAllocations", anchor: "valuationLayerId", hook: "landed-cost.ts", type: "LandedCostAllocation" },
  { controller: "ops/inv-ops.controller.ts", prefix: "inventory/ops", verb: "Get", route: "zones", service: "ops/inv-ops.service.ts", table: "invWarehouses", anchor: "deliveryPromiseMinutes", hook: "ops-board.ts", type: "DarkStoreRow" },
  { controller: "projects/inv-projects.controller.ts", prefix: "inventory/projects", verb: "Get", route: null, service: "projects/lib/project-list.ts", table: "invProjects", anchor: "openRequirements", hook: "projects-types.ts", type: "ProjectListItem", consumer: "projects-queries.ts" },
  { controller: "quality/recalls.controller.ts", prefix: "inventory/quality/recalls", verb: "Post", route: "simulate", service: "quality/recall-simulation.service.ts", table: "invLots", anchor: "manufactureDate", hook: "quality.ts", type: "RecallImpactLot" },
  { controller: "quality/recalls.controller.ts", prefix: "inventory/quality/recalls", verb: "Post", route: "simulate", service: "quality/recall-simulation.service.ts", table: "invStockLevels", anchor: "qualityHold", hook: "quality.ts", type: "RecallImpactOnHandRow" },
  { controller: "quality/recalls.controller.ts", prefix: "inventory/quality/recalls", verb: "Post", route: "simulate", service: "quality/recall-simulation.service.ts", table: "invStockTransferLines", anchor: "fromLocationId", hook: "quality.ts", type: "RecallImpactTransitRow" },
  { controller: "quality/recalls.controller.ts", prefix: "inventory/quality/recalls", verb: "Post", route: "simulate", service: "quality/recall-simulation.service.ts", table: "invShipmentLines", anchor: "shipmentNumber", hook: "quality.ts", type: "RecallImpactShippedRow" },
  { controller: "quality/recalls.controller.ts", prefix: "inventory/quality/recalls", verb: "Post", route: "simulate", service: "quality/recall-simulation.service.ts", table: "invCustomerReturnLines", anchor: "returnNumber", hook: "quality.ts", type: "RecallImpactReturnedRow" },
  { controller: "reports/inv-reports.controller.ts", prefix: "inventory/reports", verb: "Get", route: "expiry", service: "reports/inv-reports-extended.service.ts", table: "invLots", anchor: "daysUntilExpiry", hook: "reports-types.ts", type: "ExpiryReportRow", consumer: "reports.ts" },
  { controller: "settings/settings.controller.ts", prefix: "inventory/settings", verb: "Get", route: "shelf-life-rules", service: "settings/shelf-life-rules.service.ts", table: "invCustomerShelfLifeRules", anchor: "clientName", hook: "system-health.ts", type: "ShelfLifeRule" },
  { controller: "shipments/carrier-status.controller.ts", prefix: "inventory/shipments", verb: "Get", route: ":shipmentId/timeline", service: "shipments/carrier-status.service.ts", table: "invShipmentStatusEvents", anchor: "occurredAt", hook: "shipping.ts", type: "ShipmentStatusEvent" },
  /* `valuation.ts` calls the endpoint; the type it calls it through now lives in
     `valuation-schema.ts` as a zod contract, so the two files are named
     separately — see `typeMembers`. */
  { controller: "valuation/inv-valuation.controller.ts", prefix: "inventory/valuation", verb: "Get", route: "periods", service: "valuation/inventory-period.service.ts", table: "glPeriods", anchor: "periodId", hook: "valuation-schema.ts", type: "InventoryPeriod", consumer: "valuation.ts" },
  { controller: "warehouses/inv-warehouses.controller.ts", prefix: "inventory/warehouses", verb: "Get", route: ":warehouseId/users", service: "warehouses/warehouse-assignments.service.ts", table: "invUserWarehouses", anchor: "grantedByName", hook: "warehouses.ts", type: "WarehouseAssignee" },
  { controller: "warehouses/inv-warehouses.controller.ts", prefix: "inventory/warehouses", verb: "Get", route: ":warehouseId/assignable-users", service: "warehouses/warehouse-assignments.service.ts", table: "organizationMembers", anchor: "email", hook: "warehouses.ts", type: "AssignableWarehouseUser" },
  /*
    Added once the mismatch it would have reported was fixed. `createExportJob`
    returned `{ ...result, resultUrl: undefined }` — the whole ORM row with one
    column blanked — while `admin.ts` typed the response as the 12-key
    `ExportJob`. The pair was left out of this table rather than papered over
    with a contrived anchor; now that all three reads share one named projection
    it belongs here, and the shared constant is why the parser above learned to
    follow a spread.

    POST, not GET, and the distinction was worth catching. I first wrote this as
    `verb: "Get", route: "jobs"` and it passed — because the hook-call anchor
    matches the path as a substring, and `admin.ts` calls
    `POST /inventory/export/jobs` on line 258. The GET list has NO consumer in
    the frontend at all, so a pair naming it would have asserted a relationship
    that does not exist while looking green. POST is also the endpoint whose
    shape was actually wrong.
  */
  { controller: "import-export/export.controller.ts", prefix: "inventory/export", verb: "Post", route: "jobs", service: "import-export/export.service.ts", table: "invExportJobs", anchor: "errorRows", hook: "admin.ts", type: "ExportJob" },
  /*
    The endpoint this gate was written too late to catch. `listStockLevels` was
    a raw `db.execute`, so it had NO projection to read and was left off this
    table on those grounds — and meanwhile it shipped the driver's own
    snake_case column names to a hook reading camelCase, with no join at all
    behind the product and location names. `NaN` in every quantity column and a
    dash for every name, in every tenant, for the life of the endpoint. It is on
    the table now because the read is an explicit `select()`.

    State the reach plainly, because this pair is easy to over-read. `membersOf`
    records depth-1 names only, so what is compared is the TEN top-level fields
    against `RawStockLevel`'s ten. It does not see inside `productVariant` or
    `location`: Drizzle's `select()` groups columns exactly one level deep, so
    the service carries `product` and `warehouse` flat inside their parent group
    and re-nests them in TypeScript, and no key scanner reading a projection
    literal can follow that. The nested tree is pinned instead by
    `stock/__tests__/stock-levels-response-shape.spec.ts`, field by field. This
    row catches the defect that actually happened — a top-level field renamed,
    dropped, or spelled the way the driver spells it.
  */
  { controller: "stock/inv-stock.controller.ts", prefix: "inventory/stock", verb: "Get", route: null, service: "stock/inv-stock.service.ts", table: "invStockLevels", anchor: "qualityHoldQty", hook: "stock-levels.ts", type: "RawStockLevel" },
];

function endpointOf(pair: Pair): string {
  return `${pair.verb.toUpperCase()} /${pair.prefix}${pair.route === null ? "" : `/${pair.route}`}`;
}

/** The route path as the hook writes it, with `:param` standing for any `${…}`. */
function hookCallPattern(pair: Pair): RegExp {
  const path = `/${pair.prefix}${pair.route === null ? "" : `/${pair.route}`}`;
  const body = path
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? "[^\"'`/]*"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(body);
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Every pair that actually completed a comparison — the anti-vacuity ledger. */
const compared: { endpoint: string; type: string; service: string; hook: string; fields: number }[] = [];

describe("inventory response shapes against the hooks that consume them", () => {
  it.each(PAIRS.map((pair) => [`${endpointOf(pair)} → ${pair.type}`, pair] as const))(
    "%s",
    (_title, pair) => {
      /*
       * The endpoint half. Without it this is a projection-versus-interface
       * comparison that would keep passing over a route nobody can call, and
       * "endpoint ↔ hook pair" would be a claim rather than a fact.
       */
      const controllerFile = join(INVENTORY_DIR, pair.controller);
      expect(existsSync(controllerFile)).toBe(true);
      const controller = read(controllerFile);
      expect(controller).toContain(`@Controller("${pair.prefix}")`);
      const decorator =
        pair.route === null
          ? new RegExp(`@${pair.verb}\\(\\s*\\)`)
          : new RegExp(`@${pair.verb}\\(\\s*["'\`]${pair.route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
      expect(controller).toMatch(decorator);

      // The backend's declared shape.
      const serviceFile = join(INVENTORY_DIR, pair.service);
      expect(existsSync(serviceFile)).toBe(true);
      const matching = projectionsIn(read(serviceFile)).filter(
        (projection) => projection.table === pair.table && projection.keys.includes(pair.anchor),
      );
      // Zero means the anchor is gone — itself a shape change, and never a skip.
      expect({
        anchor: `${pair.service} → ${pair.table}."${pair.anchor}"`,
        projectionsFound: matching.length === 0 ? 0 : "at least one",
      }).toEqual({
        anchor: `${pair.service} → ${pair.table}."${pair.anchor}"`,
        projectionsFound: "at least one",
      });
      const declared = [...matching[0]!.keys].sort();
      for (const other of matching) {
        // Several reads may legitimately share one shape; disagreeing ones mean
        // the anchor no longer names a single projection.
        expect([...other.keys].sort()).toEqual(declared);
      }

      // The hook that consumes it.
      const consumerFile = join(HOOKS_DIR, pair.consumer ?? pair.hook);
      expect(existsSync(consumerFile)).toBe(true);
      expect(read(consumerFile)).toMatch(hookCallPattern(pair));

      const hookFile = join(HOOKS_DIR, pair.hook);
      expect(existsSync(hookFile)).toBe(true);
      const consumed = typeMembers(read(hookFile), pair.type);
      expect(consumed).not.toBeNull();

      const onWire = new Set(declared);
      const inType = new Set(consumed!);
      /*
       * Reported as two directed differences rather than one set equality,
       * because they are different bugs. A field the service stopped selecting
       * is a screen rendering `undefined`; a field the service added that no
       * type mentions is a capability the product cannot see.
       */
      expect({
        droppedByTheService: [...inType].filter((field) => !onWire.has(field)).sort(),
        absentFromTheHookType: [...onWire].filter((field) => !inType.has(field)).sort(),
      }).toEqual({ droppedByTheService: [], absentFromTheHookType: [] });

      compared.push({
        endpoint: endpointOf(pair),
        type: pair.type,
        service: pair.service,
        hook: pair.hook,
        fields: declared.length,
      });
    },
  );
});

/**
 * The floors.
 *
 * `check:*` gates in this repo have repeatedly covered a fraction of their
 * target and reported green, so the count of comparisons that actually happened
 * is itself asserted. A broken extractor, a renamed hooks folder or a pair table
 * quietly emptied all land here rather than passing as "no violations found".
 */
describe("the gate cannot pass by comparing nothing", () => {
  it("compared enough endpoint↔hook pairs, over enough fields", () => {
    expect(compared).toHaveLength(PAIRS.length);
    expect(compared.length).toBeGreaterThanOrEqual(20);
    expect(compared.reduce((sum, one) => sum + one.fields, 0)).toBeGreaterThanOrEqual(180);
  });

  it("spread them across the module rather than proving one service twice", () => {
    expect(new Set(compared.map((one) => one.service)).size).toBeGreaterThanOrEqual(12);
    expect(new Set(compared.map((one) => one.hook)).size).toBeGreaterThanOrEqual(10);
    expect(new Set(compared.map((one) => one.endpoint)).size).toBeGreaterThanOrEqual(18);
  });
});

/**
 * The document DOES describe responses now, and this gate is still needed.
 *
 * This canary used to assert the opposite: zero of the inventory operations
 * declared a 2xx response schema, which is what put the backend half of every
 * comparison above on the service's `.select()` projection instead of on
 * `openapi.json`. It said of itself that a number going UP would be good news
 * and a reason to reconsider. It went up, so this records the new number in the
 * same checkable form rather than being deleted: `@ResponseSchema` now covers
 * every inventory operation but the one `204`, which carries `x-no-content`
 * because a No Content response has no body to describe.
 *
 * What that changes: nothing about this gate's reason to exist, and one thing
 * about its reading. OpenAPI is now a second, independent statement of the
 * BACKEND half — worth comparing the projections against, as its own gate — but
 * it is silent on the half that actually breaks screens. `openapi.json` cannot
 * say whether the frontend's `LandedCostVoucherListItem` still lists the fields
 * the service sends, because the frontend's types are not in it. That
 * endpoint↔hook comparison is what the pairs above do and what no contract
 * document replaces.
 *
 * Both directions are asserted as floors so additive work does not fail here.
 */
describe("the OpenAPI document now declares response contracts", () => {
  it("declares a 2xx response schema on every inventory operation with a body", () => {
    const document = JSON.parse(read(join(BACKEND_ROOT, "openapi.json"))) as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }>; "x-no-content"?: boolean }> }>>;
    };

    let inventoryOperations = 0;
    let withResponseSchema = 0;
    const undescribed: string[] = [];
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      if (!path.startsWith("/inventory")) continue;
      for (const [verb, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(verb)) continue;
        inventoryOperations += 1;
        const success = Object.entries(operation.responses ?? {}).filter(([code]) =>
          code.startsWith("2"),
        );
        const described = success.some(([, response]) =>
          Object.values(response.content ?? {}).some((media) => media.schema !== undefined),
        );
        if (described) withResponseSchema += 1;
        // A declared No Content response is described; it just has no body.
        else if (!success.some(([, response]) => response["x-no-content"] === true))
          undescribed.push(`${verb.toUpperCase()} ${path}`);
      }
    }

    // The document is real and large, and the walk above is not matching nothing.
    expect(inventoryOperations).toBeGreaterThanOrEqual(150);
    expect(withResponseSchema).toBeGreaterThanOrEqual(150);
    // Every operation that returns a body says what that body is.
    expect(undescribed).toEqual([]);
  });
});
