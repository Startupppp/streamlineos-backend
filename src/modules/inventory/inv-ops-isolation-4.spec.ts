import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { WarehouseScopeService } from "./stock-engine/warehouse-scope.service";
import { InventorySettingsService } from "./stock-engine/inventory-settings.service";
import { INVENTORY_ISOLATION_STUBS } from "./__tests__/isolation-stubs";
import {
  makeIsolationDb,
  sqlValues,
  cacheStub,
  warehouseScopeStub,
} from "./__tests__/isolation-harness";
import { UomConversionService } from "./stock-engine/uom-conversion.service";
import { InvOpsService } from "./ops/inv-ops.service";
import { InvTaxTreatmentService } from "./products/inv-tax-treatment.service";
import { InvLabelsService } from "./labels/inv-labels.service";
import { LandedCostApplyService } from "./landed-cost/landed-cost-apply.service";
import { InvProjectsService } from "./projects/inv-projects.service";
import { PickWaveService } from "./picking/pick-wave.service";
import { PickCompletionService } from "./picking/pick-completion.service";
import { LaborService } from "./labor/labor.service";
import { SoCoreService } from "./sales-orders/so-core.service";
import { ReservationService } from "./stock-engine/reservation.service";
import { GrnService } from "./purchase-orders/grn.service";
import { NoopWesAdapter } from "./wes/wes-adapter";
import { GrnReadService } from "./purchase-orders/grn-read.service";
import { PutawayCompleteService } from "./putaway/putaway-complete.service";
import { PickConfirmService } from "./picking/pick-confirm.service";
import { PickExceptionReportService } from "./picking/pick-exception-report.service";
import { SyncBatchService } from "./sync/sync-batch.service";
import { PoService } from "./purchase-orders/po.service";

/**
 * Cross-tenant isolation, batch 4 — the last nine.
 *
 * These are the ones the previous batch could not reach. Three harness defects
 * were in the way, each of which made a correctly-scoped service look like it
 * bound no org at all:
 *
 *   - the transaction handle was `fn({})`, so work inside `db.transaction`
 *     recorded nothing;
 *   - `sqlValues` descended only `queryChunks`/`value`, so Drizzle's RELATIONAL
 *     reader — which passes `{ where, columns }` — was never opened;
 *   - the cache double was missing `cachedVersionedForOrg` and six more real
 *     methods, so a service reading through one died on "not a function".
 *
 * All three produce a FALSE NEGATIVE, which is the tolerable direction: the
 * test fails loudly and costs time. The same blindness written the other way —
 * asserting only `not.toContain(victim)` — would have passed all nine while
 * proving nothing.
 */

const OWNER = "org-owner";
const ATTACKER = "org-attacker";
const USER = "user-1";
const KEY = "idem-1";
const ROW = {
  id: 1,
  orgId: OWNER,
  code: "OWNED-1",
  status: "OPEN",
  warehouseId: 1,
  productVariantId: 1,
  uomId: 2,
  quantity: "1",
  factorToBase: "1",
  isActive: true,
};

/** GST on, so InvTaxTreatmentService actually reads a classification. */
const GST_SETTINGS = {
  packs: { warehouse: true, kirana: false, pharmacy: false, gst: true, quickCommerce: false },
  gstMode: "REGULAR",
};

const EXTRA = [
  { provide: "APP_CONFIG", useValue: { get: jest.fn().mockReturnValue(undefined) } },
  { provide: NoopWesAdapter, useValue: { assignTask: jest.fn().mockResolvedValue(undefined), ack: jest.fn().mockResolvedValue(undefined) } },
  {
    provide: InvProjectsService,
    useValue: {
      listProjects: jest.fn().mockResolvedValue({ items: [] }),
      getProject: jest.fn().mockResolvedValue(null),
      coverageFor: jest.fn().mockResolvedValue([]),
      atRiskRequirements: jest.fn().mockResolvedValue([]),
    },
  },
  {
    provide: PickWaveService,
    useValue: {
      listWaves: jest.fn().mockResolvedValue({ items: [] }),
      getWave: jest.fn().mockResolvedValue(null),
      claimWave: jest.fn().mockResolvedValue(undefined),
      abandonWave: jest.fn().mockResolvedValue(undefined),
      reassignWave: jest.fn().mockResolvedValue(undefined),
    },
  },
  {
    provide: PickCompletionService,
    useValue: {
      claimForConfirm: jest.fn().mockResolvedValue(null),
      consumeCoveredReservations: jest.fn().mockResolvedValue(undefined),
      rollUpSoStatus: jest.fn().mockResolvedValue(undefined),
      finishWave: jest.fn().mockResolvedValue(undefined),
      syncGrains: jest.fn().mockResolvedValue(undefined),
    },
  },
  {
    provide: LaborService,
    useValue: {
      recordInTx: jest.fn().mockResolvedValue(undefined),
      board: jest.fn().mockResolvedValue({ items: [] }),
      recentFor: jest.fn().mockResolvedValue([]),
    },
  },
  {
    provide: SoCoreService,
    useValue: {
      listSos: jest.fn().mockResolvedValue({ items: [] }),
      getSo: jest.fn().mockResolvedValue(null),
      getAtp: jest.fn().mockResolvedValue({ available: "0" }),
      findAvailableLotForLine: jest.fn().mockResolvedValue(null),
    },
  },
  {
    provide: ReservationService,
    useValue: {
      createReservation: jest.fn().mockResolvedValue(null),
      createReservationInTx: jest.fn().mockResolvedValue(null),
      releaseReservationInTx: jest.fn().mockResolvedValue(undefined),
      consumeReservation: jest.fn().mockResolvedValue(undefined),
      consumeReservationsBatch: jest.fn().mockResolvedValue([]),
      expireStale: jest.fn().mockResolvedValue(0),
    },
  },
  {
    // SyncBatchService injects it. The PickConfirmService case below still gets
    // the REAL class: `cls` is registered after EXTRA and the last provider for
    // a token wins.
    provide: PickConfirmService,
    useValue: { confirmPick: jest.fn().mockResolvedValue(undefined) },
  },
  {
    provide: GrnService,
    useValue: {
      getGrn: jest.fn().mockResolvedValue(null),
      createDraft: jest.fn().mockResolvedValue(null),
      postGrn: jest.fn().mockResolvedValue(undefined),
      receiveGoods: jest.fn().mockResolvedValue(undefined),
    },
  },
];

/**
 * A GRN and its PO, shaped just enough for `grnNote` to reach its OWN query.
 *
 * Without these the service takes `grn.poId` off a null and throws before
 * touching the database — which a throw-tolerant test reads as "bound no org",
 * indistinguishable from a service with no tenant predicate. The point of the
 * test is the read at the end of that path: `baseUomByProduct`, which until this
 * commit filtered on product id alone.
 */
const GRN_FIXTURE = {
  poId: 1,
  lines: [{ poLineId: 1, quantityExpected: "1", quantityReceived: "1", lotNumber: null, expiryDate: null }],
};
const PO_FIXTURE = {
  id: 1,
  lines: [
    {
      id: 1,
      productVariant: { sku: "SKU-1", name: "V", product: { id: 1, name: "P", sku: "SKU-1" } },
    },
  ],
};
const LABELS_PROVIDERS = [
  { provide: GrnReadService, useValue: { listGrns: jest.fn().mockResolvedValue({ items: [] }), getGrn: jest.fn().mockResolvedValue(GRN_FIXTURE) } },
  { provide: PoService, useValue: { getPo: jest.fn().mockResolvedValue(PO_FIXTURE), listPos: jest.fn().mockResolvedValue({ items: [] }) } },
];

/**
 * Read the org out of predicates AND out of insert payloads.
 *
 * For an idempotent command the tenant scoping is the INSERT: `claimIdempotencyKey`
 * stamps `orgId` into the row it writes and never puts it in a `where` at all. A
 * helper that watched only predicates reported every one of them as unscoped.
 * Insert payloads are plain objects, so their values are taken directly rather
 * than walked as SQL.
 */
function boundValues(...mocks: jest.Mock[]): unknown[] {
  return mocks.flatMap((m) =>
    m.mock.calls.flatMap((c) => {
      const arg = c[0];
      const asSql = sqlValues(arg);
      const asPayload =
        arg !== null && typeof arg === "object" && !Array.isArray(arg)
          ? Object.values(arg as Record<string, unknown>)
          : [];
      return [...asSql, ...asPayload];
    }),
  );
}

async function build<T>(cls: new (...a: never[]) => T, settings?: unknown, extra: unknown[] = []) {
  const h = makeIsolationDb([ROW]);
  const moduleRef = await Test.createTestingModule({
    providers: [
      ...INVENTORY_ISOLATION_STUBS,
      ...(EXTRA as never[]),
      cls,
      { provide: DRIZZLE, useValue: h.db },
      { provide: CacheService, useValue: cacheStub() },
      { provide: WarehouseScopeService, useValue: warehouseScopeStub() },
      ...(settings
        ? [{ provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue(settings) } }]
        : []),
      ...(extra as never[]),
    ],
  }).compile();
  return { svc: moduleRef.get(cls), ...h };
}

function isolates<T>(
  name: string,
  cls: new (...a: never[]) => T,
  call: (svc: T, orgId: string) => Promise<unknown>,
  settings?: unknown,
  extra: unknown[] = [],
) {
  describe(`${name} — cross-tenant isolation`, () => {
    it("binds the caller's org before acting (isolation — deny)", async () => {
      const h = await build(cls, settings, extra);
      await call(h.svc, ATTACKER).catch(() => undefined);
      const bound = boundValues(h.selectWhere, h.findMany, h.findFirst, h.execute, h.insertValues, h.writeWhere);
      expect(bound).toContain(ATTACKER);
      expect(bound).not.toContain(OWNER);
    });

    it("binds the owning org before acting (isolation — control)", async () => {
      const h = await build(cls, settings, extra);
      await call(h.svc, OWNER).catch(() => undefined);
      expect(
        boundValues(h.selectWhere, h.findMany, h.findFirst, h.execute, h.insertValues, h.writeWhere),
      ).toContain(OWNER);
    });
  });
}

isolates("UomConversionService", UomConversionService, (s, org) => s.factorFor(org, 1, 2));
isolates("InvOpsService", InvOpsService, (s, org) => s.zoneBoard(org, USER));
isolates("InvTaxTreatmentService", InvTaxTreatmentService, (s, org) =>
  s.resolveLineTax(org, { productVariantId: 1, documentKind: "INVOICE", taxableAmount: "100" } as never), GST_SETTINGS);
isolates("InvLabelsService", InvLabelsService, (s, org) => s.grnNote(org, 1, USER), undefined, LABELS_PROVIDERS);
isolates("LandedCostApplyService", LandedCostApplyService, (s, org) => s.applyVoucher(org, USER, 1, KEY));
isolates("PutawayCompleteService", PutawayCompleteService, (s, org) => s.complete(org, USER, 1, {} as never, KEY));
isolates("PickConfirmService", PickConfirmService, (s, org) => s.confirmPick(org, USER, 1, {} as never, KEY));
isolates("PickExceptionReportService", PickExceptionReportService, (s, org) => s.reportException(org, USER, 1, {} as never, KEY));
isolates("SyncBatchService", SyncBatchService, (s, org) => s.apply(org, USER, { operations: [{ kind: "SCAN", barcode: "X" }] } as never));
