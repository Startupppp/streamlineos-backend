import type { Provider } from "@nestjs/common";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { ChannelPoolService } from "../stock-engine/channel-pool.service";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { InventoryPeriodService } from "../valuation/inventory-period.service";
import { VendorScorecardService } from "../vendors/vendor-scorecard.service";
import { CartonizationService } from "../shipments/cartonization.service";
import { StagedImportService } from "../import-export/staged-import.service";
import { ReorderProposalService } from "../replenishment/forecast/reorder-proposal.service";
import { InvValuationService } from "../valuation/inv-valuation.service";
import { WebhookTransportService } from "../webhooks/webhook-transport.service";
import { UomConversionService } from "../stock-engine/uom-conversion.service";
import { InvAiService } from "../ai/inv-ai.service";
import { AccessService } from "../../access/access.service";
import { CostVisibilityService } from "../stock-engine/cost-visibility";
import { TransitLocationService } from "../stock-engine/transit-location.service";
import { InvBarcodeService } from "../barcode/inv-barcode.service";
import { RecallSimulationService } from "../quality/recall-simulation.service";
import { IndiaComplianceService } from "../compliance/india-compliance.service";
import { MovementApplyService } from "../stock-engine/movement-apply.service";
import { InvQuantityCaptureService } from "../products/inv-quantity-capture.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { PoService } from "../purchase-orders/po.service";
import { GrnPostingService } from "../purchase-orders/grn-post.service";
import { GrnReadService } from "../purchase-orders/grn-read.service";
import { QuickCommerceInboundService } from "../channels/quick-commerce/quick-commerce-inbound.service";
import { HandlingUnitService } from "../handling-units/handling-unit.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";

/**
 * Dependencies these cross-tenant specs construct but do not exercise.
 *
 * Every one of these specs asserts a single thing: that the query carries the
 * caller's `org_id`. The services they build have since grown collaborators
 * that have nothing to do with that question, and each new one broke every
 * spec of the shape with `Nest can't resolve dependencies` -- a DI error that
 * reads as a tenant-isolation failure and is not one.
 *
 * Spread this FIRST in a `providers` array: Nest resolves the last registration
 * for a token, so anything the spec provides itself still wins. A stub here is
 * therefore never the thing under test.
 */
export const INVENTORY_ISOLATION_STUBS: Provider[] = [
  {
    provide: WarehouseScopeService,
    useValue: {
      // `resolve: null` is the unrestricted caller, so every predicate passes
      // and the cache discriminator is the constant scopeKey() returns for it.
      resolve: jest.fn().mockResolvedValue(null),
      scopeKey: jest.fn().mockReturnValue("all"),
      forUser: jest.fn().mockResolvedValue({
        key: "all",
        isEmpty: false,
        unrestricted: true,
        warehouse: () => ({ queryChunks: [] }),
        location: () => ({ queryChunks: [] }),
        anyOf: () => ({ queryChunks: [] }),
      }),
      locationPredicate: jest.fn().mockReturnValue({ queryChunks: [] }),
      warehousePredicate: jest.fn().mockReturnValue({ queryChunks: [] }),
      warehouseIdList: jest.fn().mockReturnValue(null),
      assertWarehouseVisible: jest.fn().mockResolvedValue(undefined),
      assertLocationVisible: jest.fn().mockResolvedValue(undefined),
    },
  },
  { provide: NumberSequenceService, useValue: { next: jest.fn().mockResolvedValue("SEQ-1") } },
  {
    provide: StockProjectionService,
    useValue: {
      syncOutgoing: jest.fn().mockResolvedValue(undefined),
      addOnOrder: jest.fn().mockResolvedValue(undefined),
    },
  },
  {
    provide: ChannelPoolService,
    useValue: {
      availability: jest.fn().mockResolvedValue({ items: [] }),
      availabilityFor: jest.fn().mockResolvedValue({ available: "0" }),
      assertPromisable: jest.fn().mockResolvedValue(undefined),
      allocate: jest.fn().mockResolvedValue(undefined),
      allocateInTx: jest.fn().mockResolvedValue(undefined),
      consumeInTx: jest.fn().mockResolvedValue(undefined),
      recordPublishedInTx: jest.fn().mockResolvedValue(undefined),
      listForChannel: jest.fn().mockResolvedValue([]),
      listForVariant: jest.fn().mockResolvedValue([]),
    },
  },
  {
    provide: InventoryAccountingBridge,
    /**
     * The real surface. It used to say `postMovement`, which does not exist on
     * InventoryAccountingBridge at all — and because this file is not a
     * `.spec.ts`, `check:mock-surface` never read it. A phantom in a SHARED stub
     * is the worst place for one: it is inherited by every spec that imports
     * INVENTORY_ISOLATION_STUBS, and the missing real methods surface as
     * "hasPeriods is not a function" in whichever spec first reaches that branch,
     * looking like a bug in the service.
     */
    useValue: {
      hasJournals: jest.fn().mockResolvedValue(false),
      hasPeriods: jest.fn().mockResolvedValue(false),
      resolveAccountCodes: jest.fn().mockResolvedValue({}),
      assertOpen: jest.fn().mockResolvedValue(undefined),
      postJournalEntry: jest.fn().mockResolvedValue(undefined),
    },
  },
  {
    provide: InventorySettingsService,
    useValue: (() => {
      const defaults = {
        allowNegativeStock: false,
        allowBackorders: false,
        reservationStrategy: "AUTO_ON_CONFIRM",
        defaultCostingMethod: "WEIGHTED_AVERAGE",
        expiryReservationPolicy: "BLOCK",
        inspectionOnReceipt: false,
        inspectionOnReturn: false,
        overReceiptTolerancePct: "0.00",
        requirePoApproval: false,
        adjustmentApprovalThreshold: null,
        autoReserveOnConfirm: true,
        allowPartialShipment: true,
        packageRequiredForShipping: false,
        channelPublishPolicy: null,
        packs: { warehouse: true, kirana: false, pharmacy: false, gst: false, quickCommerce: false },
        gstMode: "REGULAR",
        nearExpiryPolicy: "DEPRIORITIZE",
        nearExpiryWindowDays: 30,
        gstEinvoiceEnabled: false,
        gstEwaybillEnabled: false,
        tallyExportEnabled: false,
        complianceAdapter: "stub",
        pharmacyH1RegisterEnabled: false,
        qcZeptoEmailPoEnabled: false,
        asnRequiredForGrn: false,
        wavelessPicking: false,
        wavelessMaxLines: 50,
      };
      return { get: jest.fn().mockResolvedValue(defaults), getForOrg: jest.fn().mockResolvedValue(defaults) };
    })(),
  },
  {
    provide: InventoryPeriodService,
    useValue: {
      listPeriods: jest.fn().mockResolvedValue({ installed: false, items: [] }),
      findPeriod: jest.fn().mockResolvedValue(null),
      // AsAtGrain, not null: callers read `.asOfDate` off it immediately
      // (inv-valuation.service.ts:117). A null here is not a neutral default,
      // it is a crash one frame later.
      resolveAsAt: jest.fn().mockResolvedValue({ asOfDate: "2099-01-01", period: null }),
      resolveWindow: jest.fn().mockResolvedValue({ from: "2099-01-01", to: "2099-01-31", period: null }),
      periodCovering: jest.fn().mockResolvedValue(null),
    },
  },
  {
    provide: InvAiService,
    useValue: {
      listInsights: jest.fn().mockResolvedValue({ items: [] }),
      generateInsights: jest.fn().mockResolvedValue({ items: [] }),
      updateInsightStatus: jest.fn().mockResolvedValue(undefined),
      getOpsBrief: jest.fn().mockResolvedValue({ sections: [] }),
    },
  },
  {
    provide: AccessService,
    /**
     * `resolveUserPermissions` answers a Set of permission keys — that shape is
     * the real contract and is kept. The entry also carried `hasPermission`,
     * which AccessService does not have; the real predicate is `holds`.
     */
    useValue: {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
      holds: jest.fn().mockResolvedValue(true),
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      isCoreModule: jest.fn().mockReturnValue(false),
      scopeFor: jest.fn().mockResolvedValue("all"),
      getAccessSnapshot: jest.fn().mockResolvedValue({ permissions: [] }),
      membersWithPermission: jest.fn().mockResolvedValue([]),
    },
  },
  { provide: VendorScorecardService, useValue: { scorecardsFor: jest.fn().mockResolvedValue(new Map()) } },
  { provide: CartonizationService, useValue: { suggest: jest.fn().mockResolvedValue([]), assertFits: jest.fn().mockResolvedValue(undefined) } },
  { provide: StagedImportService, useValue: {
      createJob: jest.fn().mockResolvedValue({ id: 1 }),
      stageRows: jest.fn().mockResolvedValue({ rows: [] }),
      processChunk: jest.fn().mockResolvedValue({ finished: true }),
      cancel: jest.fn().mockResolvedValue(undefined),
      errors: jest.fn().mockResolvedValue({ items: [] }),
      progress: jest.fn().mockResolvedValue({ processed: 0 }),
    } },
  { provide: ReorderProposalService, useValue: { propose: jest.fn().mockResolvedValue([]) } },
  { provide: InvValuationService, useValue: {
      getValuationSummary: jest.fn().mockResolvedValue({ items: [] }),
      getValuationLayers: jest.fn().mockResolvedValue({ items: [] }),
      getValuationConsumptions: jest.fn().mockResolvedValue({ items: [] }),
      listPeriods: jest.fn().mockResolvedValue({ items: [] }),
    } },
  { provide: WebhookTransportService, useValue: { deliver: jest.fn().mockResolvedValue(undefined) } },
  {
    provide: UomConversionService,
    useValue: {
      factorFor: jest.fn().mockResolvedValue("1"),
      convert: jest.fn().mockResolvedValue("1"),
    },
  },
  { provide: CostVisibilityService, useValue: { canSeeCost: jest.fn().mockResolvedValue(false) } },
  {
    provide: TransitLocationService,
    useValue: { resolve: jest.fn().mockResolvedValue(null) },
  },
  { provide: InvBarcodeService, useValue: {
      lookup: jest.fn().mockResolvedValue(null),
      scan: jest.fn().mockResolvedValue(null),
      captureScan: jest.fn().mockResolvedValue(undefined),
      buildLabel: jest.fn().mockResolvedValue(""),
    } },
  { provide: RecallSimulationService, useValue: { simulate: jest.fn().mockResolvedValue({ lines: [] }) } },
  {
    provide: IndiaComplianceService,
    useValue: {
      register: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
      documentsFor: jest.fn().mockResolvedValue([]),
    },
  },
  { provide: MovementApplyService, useValue: { apply: jest.fn().mockResolvedValue(undefined) } },
  {
    provide: InvQuantityCaptureService,
    useValue: {
      packEnabled: jest.fn().mockResolvedValue(false),
      captureContract: jest.fn().mockResolvedValue(null),
      assertEnteredQuantity: jest.fn().mockResolvedValue(undefined),
      assertProductUnitsConvertible: jest.fn().mockResolvedValue(undefined),
    },
  },
  { provide: InventoryAuditService, useValue: { insert: jest.fn().mockResolvedValue(undefined) } },
  { provide: PoService, useValue: { getPo: jest.fn().mockResolvedValue(null), listPos: jest.fn().mockResolvedValue({ items: [] }) } },
  { provide: GrnPostingService, useValue: { postGrn: jest.fn().mockResolvedValue(undefined) } },
  { provide: GrnReadService, useValue: { listGrns: jest.fn().mockResolvedValue({ items: [] }), getGrn: jest.fn().mockResolvedValue(null) } },
  { provide: QuickCommerceInboundService, useValue: {
      ingestPurchaseOrder: jest.fn().mockResolvedValue({ accepted: 0 }),
      acceptPurchaseOrder: jest.fn().mockResolvedValue(undefined),
      createAsn: jest.fn().mockResolvedValue({ id: 1 }),
      asnDetail: jest.fn().mockResolvedValue(null),
      listAsns: jest.fn().mockResolvedValue({ items: [] }),
      list: jest.fn().mockResolvedValue({ items: [] }),
      detail: jest.fn().mockResolvedValue(null),
      assertReceivable: jest.fn().mockResolvedValue(undefined),
    } },
  { provide: HandlingUnitService, useValue: {
      create: jest.fn().mockResolvedValue(null),
      detail: jest.fn().mockResolvedValue(null),
      move: jest.fn().mockResolvedValue(undefined),
      nest: jest.fn().mockResolvedValue(undefined),
      assertCanHoldStockInTx: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ items: [] }),
    } },
  { provide: StockEngineService, useValue: { execute: jest.fn().mockResolvedValue(undefined) } },
];
