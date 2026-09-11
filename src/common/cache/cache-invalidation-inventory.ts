import type { CacheNamespaceEntry } from "./cache-invalidation-types";

export const INVENTORY_CACHE_ENTRIES: readonly CacheNamespaceEntry[] = [
  {
    namespace: "inv:products:list:<orgId>",
    description: "Inventory products list",
    invalidation: {
      kind: "write",
      events: ["InventoryProductsService (any write)"],
    },
  },
  {
    namespace: "inv:po:list:<orgId>",
    description: "Purchase orders list",
    invalidation: {
      kind: "write",
      events: ["PurchaseOrdersService (any write)"],
    },
  },
  {
    namespace: "inv:grn:list:<orgId>",
    description: "Goods-received notes list",
    invalidation: {
      kind: "write",
      events: ["GrnService (any write)"],
    },
  },
  {
    namespace: "inv:vendors:list:<orgId>",
    description: "Vendor list",
    invalidation: {
      kind: "write",
      events: ["VendorsService (any write)"],
    },
  },
  {
    namespace: "inv:so:list:<orgId>",
    description: "Sales orders list",
    invalidation: {
      kind: "write",
      events: ["SalesOrdersService (any write)"],
    },
  },
  {
    // Documented "ttl-only ... a deliberate decision" while four `invalidate()`
    // calls were in fact aimed at it — and missing, because the reader
    // discriminates on the caller's warehouse scope. Now a real namespace bump.
    namespace: "inv:dashboard:<orgId>",
    description: "Inventory dashboard (scope sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["invalidateStockDerivedReads (both stock engines, adjustment and transfer cancels)"],
    },
  },
  {
    namespace: "inv:replenishment:suggestions:<orgId>",
    description: "Replenishment suggestions",
    invalidation: { kind: "ttl-only", reason: "Computationally expensive aggregate; 5-min TTL accepted" },
  },
  {
    namespace: "inv:products:detail:<orgId>:<id>",
    description: "Inventory product detail",
    invalidation: {
      kind: "write",
      events: ["InvProductCrudService.update/delete/updateVariant (del+invalidateNamespace(invProductsNamespace))"],
    },
  },
  {
    namespace: "inv:warehouses:detail:<orgId>:<id>",
    description: "Warehouse detail (plus namespace-versioned list via inv:warehouses namespace)",
    invalidation: {
      kind: "write",
      events: ["InvWarehousesService.update (del detail + invalidateNamespaceForOrg('inv:warehouses'))"],
    },
  },
  {
    namespace: "inv:po:detail:<orgId>:<id>",
    description: "Purchase order detail",
    invalidation: {
      kind: "write",
      events: ["PoService.update/send/close/cancel", "GrnService.receive", "GrnReceiveService.receive"],
    },
  },
  {
    namespace: "inv:vret:list:<orgId>",
    description: "Vendor returns list",
    invalidation: {
      kind: "write",
      events: ["VendorReturnsService (any write)"],
    },
  },
  {
    namespace: "inv:vret:detail:<orgId>:<id>",
    description: "Vendor return detail",
    invalidation: {
      kind: "write",
      events: ["VendorReturnsService (any write)"],
    },
  },
  {
    namespace: "inv:cret:list:<orgId>",
    description: "Customer returns list",
    invalidation: {
      kind: "write",
      events: ["CustomerReturnsService (any write)"],
    },
  },
  {
    namespace: "inv:cret:detail:<orgId>:<id>",
    description: "Customer return detail",
    invalidation: {
      kind: "write",
      events: ["CustomerReturnsService (any write)"],
    },
  },
  {
    namespace: "inv:so:detail:<orgId>:<id>",
    description: "Sales order detail",
    invalidation: {
      kind: "write",
      events: ["SoLifecycleService", "SoFulfillmentService", "SoCoreService (all del detail + invalidateNamespace(invSoNamespace))"],
    },
  },
  {
    // Was two entries, a parent and a "paged" child said to be reached
    // "implicitly via the inv:reorder parent". Redis has no prefix delete, so
    // the parent reached nothing: one namespace, scope/page/limit beneath it.
    namespace: "inv:reorder:<orgId>",
    description: "Inventory reorder report (scope, page and limit sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["invalidateStockDerivedReads (both stock engines, adjustment and transfer cancels)"],
    },
  },
  {
    namespace: "inv:stock:summary-report:<orgId>",
    description: "Stock summary report (scope, page and limit sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["invalidateStockDerivedReads (both stock engines, adjustment and transfer cancels)"],
    },
  },
  {
    namespace: "inv:valuation:report:<orgId>",
    description: "Inventory valuation report (hash sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches (on any stock adjustment affecting valuation)"],
    },
  },
  {
    namespace: "inv:slow-moving:<orgId>",
    description: "Slow-moving inventory report (hash sub-keyed)",
    invalidation: {
      kind: "ttl-only",
      reason: "Aggregate report; acceptable staleness; computed on demand with TTL",
    },
  },
  {
    namespace: "inv:expiry:report:<orgId>",
    description: "Expiry-approaching inventory report (hash sub-keyed)",
    invalidation: {
      kind: "ttl-only",
      reason: "Time-bounded aggregate; TTL is the natural invalidation mechanism as expiry is date-driven",
    },
  },
  {
    // Read through the *ForOrg family, so the counter is region-scoped and a
    // plain `invalidateNamespace` with the same literal would bump a different
    // key. Undocumented and unbumped until 2026-09-12: the board showed
    // pre-movement quantities for its whole TTL after every stock write.
    namespace: "inv:ops:zones:<orgId>",
    description: "Dark-store zone board (warehouse-scope sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["invalidateStockDerivedReads (both stock engines, adjustment and transfer cancels)"],
    },
  },
  {
    namespace: "inv:ops:summary:<orgId>",
    description: "Inventory operations headline figures (warehouse-scope sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["invalidateStockDerivedReads (both stock engines, adjustment and transfer cancels)"],
    },
  },
  {
    namespace: "inv:physical-audits:list:<orgId>",
    description: "Physical audit list (warehouse-scope, status, page sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["createAudit", "postAudit (physical-audit-commands.ts)"],
    },
  },
  {
    namespace: "inv:physical-audits:detail:<orgId>:<id>",
    description: "Physical audit detail",
    invalidation: {
      kind: "write",
      events: ["start/updateLines/review/post/cancel (physical-audit-commands.ts)"],
    },
  },
];
