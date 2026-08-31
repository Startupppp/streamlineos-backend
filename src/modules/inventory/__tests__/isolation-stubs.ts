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
      recompute: jest.fn().mockResolvedValue(undefined),
    },
  },
  {
    provide: ChannelPoolService,
    useValue: {
      reservedForChannel: jest.fn().mockResolvedValue("0"),
      claim: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    },
  },
  {
    provide: InventoryAccountingBridge,
    useValue: { postMovement: jest.fn().mockResolvedValue(undefined) },
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
      assertOpen: jest.fn().mockResolvedValue(undefined),
      currentPeriod: jest.fn().mockResolvedValue(null),
      resolveAsAt: jest.fn().mockResolvedValue({ asOfDate: "2999-12-31", periodId: null }),
    },
  },
  { provide: VendorScorecardService, useValue: { scorecardsFor: jest.fn().mockResolvedValue(new Map()) } },
  { provide: CartonizationService, useValue: { plan: jest.fn().mockResolvedValue([]) } },
  { provide: StagedImportService, useValue: { stage: jest.fn().mockResolvedValue({ rows: [] }) } },
  { provide: ReorderProposalService, useValue: { propose: jest.fn().mockResolvedValue([]) } },
  { provide: InvValuationService, useValue: { summary: jest.fn().mockResolvedValue({ items: [] }) } },
  { provide: WebhookTransportService, useValue: { deliver: jest.fn().mockResolvedValue(undefined) } },
  {
    provide: UomConversionService,
    useValue: { toBase: jest.fn().mockResolvedValue("1"), factorFor: jest.fn().mockResolvedValue("1") },
  },
  { provide: InvAiService, useValue: { listInsights: jest.fn().mockResolvedValue({ items: [] }) } },
  {
    provide: AccessService,
    useValue: {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
      hasPermission: jest.fn().mockResolvedValue(true),
    },
  },
  { provide: CostVisibilityService, useValue: { canSeeCost: jest.fn().mockResolvedValue(false) } },
  {
    provide: TransitLocationService,
    useValue: { ensureFor: jest.fn().mockResolvedValue({ id: 1 }), transitLocationId: jest.fn().mockResolvedValue(1) },
  },
  { provide: InvBarcodeService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
  { provide: RecallSimulationService, useValue: { simulate: jest.fn().mockResolvedValue({ lines: [] }) } },
  {
    provide: IndiaComplianceService,
    useValue: { assertShippable: jest.fn().mockResolvedValue(undefined), gst: jest.fn().mockReturnValue(null) },
  },
  { provide: MovementApplyService, useValue: { apply: jest.fn().mockResolvedValue(undefined) } },
  {
    provide: InvQuantityCaptureService,
    useValue: { assertReceiptLine: jest.fn(), capture: jest.fn().mockReturnValue({}) },
  },
  { provide: InventoryAuditService, useValue: { insert: jest.fn().mockResolvedValue(undefined) } },
  { provide: PoService, useValue: { getPo: jest.fn().mockResolvedValue(null), listPos: jest.fn().mockResolvedValue({ items: [] }) } },
  { provide: GrnPostingService, useValue: { postGrn: jest.fn().mockResolvedValue(undefined) } },
  { provide: GrnReadService, useValue: { list: jest.fn().mockResolvedValue({ items: [] }), get: jest.fn().mockResolvedValue(null) } },
  { provide: QuickCommerceInboundService, useValue: { ingest: jest.fn().mockResolvedValue({ accepted: 0 }) } },
  { provide: HandlingUnitService, useValue: { receiveOnto: jest.fn().mockResolvedValue(null), move: jest.fn().mockResolvedValue(undefined) } },
  { provide: StockEngineService, useValue: { execute: jest.fn().mockResolvedValue(undefined) } },
];
