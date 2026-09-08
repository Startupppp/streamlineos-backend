import type { CacheNamespaceEntry } from "./cache-invalidation-types";

export const INVENTORY_FULFILLMENT_CACHE_ENTRIES: readonly CacheNamespaceEntry[] = [
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
