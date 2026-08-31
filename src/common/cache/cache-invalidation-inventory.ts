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
    namespace: "inv:stock:summary:<orgId>",
    description: "Inventory stock summary",
    invalidation: {
      kind: "write",
      events: ["StockService (any write)"],
    },
  },
  {
    namespace: "inv:dashboard:<orgId>",
    description: "Inventory dashboard",
    invalidation: {
      kind: "ttl-only",
      reason: "Aggregate; TTL-only is a deliberate decision — staleness < 5 min is acceptable",
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
    namespace: "inv:low-stock:<orgId>",
    description: "Low-stock alert list",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches", "StockEngineBatchService.invalidateCaches"],
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
    namespace: "inv:reorder:<orgId>",
    description: "Inventory reorder report",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches", "StockEngineBatchService.invalidateCaches"],
    },
  },
  {
    namespace: "inv:reorder:paged:<orgId>",
    description: "Paged inventory reorder report (hash sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches (implicitly via inv:reorder parent)"],
    },
  },
  {
    namespace: "inv:stock:summary-report:<orgId>",
    description: "Stock summary report (paged, hash sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches (stock movement events)"],
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
    namespace: "inv:cycle-counts:list:<orgId>",
    description: "Cycle count sessions list",
    invalidation: {
      kind: "write",
      events: ["InvCycleCountsService (any write)"],
    },
  },
  {
    namespace: "inv:cycle-counts:detail:<orgId>:<id>",
    description: "Cycle count session detail",
    invalidation: {
      kind: "write",
      events: ["InvCycleCountsService (any write)"],
    },
  },
  {
    namespace: "inv:quality:inspections:<orgId>",
    description: "Quality inspections list",
    invalidation: {
      kind: "write",
      events: ["QualityInspectionsService (any write)"],
    },
  },
  {
    namespace: "inv:quality:holds:<orgId>",
    description: "Quality holds list",
    invalidation: {
      kind: "write",
      events: ["QualityInspectionsService (any write)"],
    },
  },
  {
    namespace: "inv:quality:recalls:<orgId>",
    description: "Quality recalls list",
    invalidation: {
      kind: "write",
      events: ["QualityRecallsService (any write)"],
    },
  },
  {
    namespace: "inv:packages:<orgId>",
    description: "Packages list",
    invalidation: {
      kind: "write",
      events: ["PackagesService (any write)"],
    },
  },
  {
    namespace: "inv:shipments:<orgId>",
    description: "Shipments list",
    invalidation: {
      kind: "write",
      events: ["ShipmentsService (any write)"],
    },
  },
  {
    namespace: "inv:loads:<orgId>",
    description: "Loads list",
    invalidation: {
      kind: "write",
      events: ["LoadsService (any write)"],
    },
  },
  {
    namespace: "inv:carriers:<orgId>",
    description: "Carriers list",
    invalidation: {
      kind: "write",
      events: ["CarriersService (any write)"],
    },
  },
  {
    namespace: "inv:channels:list:<orgId>",
    description: "Sales channel list",
    invalidation: {
      kind: "write",
      events: ["InvChannelsService (any write)"],
    },
  },
  {
    namespace: "inv:channels:detail:<orgId>:<id>",
    description: "Sales channel detail",
    invalidation: {
      kind: "write",
      events: ["InvChannelsService (any write)"],
    },
  },
  {
    namespace: "inv:3pl:list:<orgId>",
    description: "Third-party logistics partner list",
    invalidation: {
      kind: "write",
      events: ["Inv3plService (any write)"],
    },
  },
  {
    namespace: "inv:import-jobs:list:<orgId>",
    description: "Inventory import job list",
    invalidation: {
      kind: "write",
      events: ["InvImportService.updateJobStatus (invalidateNamespace)"],
    },
  },
  {
    namespace: "inv:export-jobs:list:<orgId>",
    description: "Inventory export job list",
    invalidation: {
      kind: "write",
      events: ["InvExportService (any write)"],
    },
  },
  {
    namespace: "inv:settings:<orgId>",
    description: "Inventory module settings",
    invalidation: {
      kind: "write",
      events: ["InvSettingsService.updateSettings (invalidate(CACHE_KEYS.invSettings(orgId)))"],
    },
  },
  {
    namespace: "inv:numseq:<orgId>",
    description: "Inventory number sequences (PO/GRN/SO/etc. reference number counters)",
    invalidation: {
      kind: "write",
      events: ["InvSettingsService.updateNumberSequence (invalidate(CACHE_KEYS.invNumberSequences(orgId)))"],
    },
  },
  {
    namespace: "inv:ai-insights:<orgId>",
    description: "Inventory AI-generated insights list",
    invalidation: {
      kind: "write",
      events: ["InvAiService.generateInsights", "InvAiService.dismissInsight"],
    },
  },
];
