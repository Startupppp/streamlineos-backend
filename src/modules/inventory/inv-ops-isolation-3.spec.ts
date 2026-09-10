import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { WarehouseScopeService } from "./stock-engine/warehouse-scope.service";
import { INVENTORY_ISOLATION_STUBS } from "./__tests__/isolation-stubs";
import {
  makeIsolationDb,
  sqlValues,
  cacheStub,
  warehouseScopeStub,
} from "./__tests__/isolation-harness";
import { FillRateService } from "./channels/quick-commerce/fill-rate.service";
import { QuickCommerceInboundService } from "./channels/quick-commerce/quick-commerce-inbound.service";
import { IndiaComplianceService } from "./compliance/india-compliance.service";
import { HandlingUnitService } from "./handling-units/handling-unit.service";
import { InvPharmacyService } from "./products/inv-pharmacy.service";
import { InvQuantityCaptureService } from "./products/inv-quantity-capture.service";
import { DemandBaselineService } from "./replenishment/forecast/demand-baseline.service";
import { RecallSimulationService } from "./quality/recall-simulation.service";
import { ReceiptInspectionService } from "./quality/receipt-inspection.service";
import { CartonizationService } from "./shipments/cartonization.service";
import { PickWaveService } from "./picking/pick-wave.service";
import { PickCompletionService } from "./picking/pick-completion.service";
import { InvProjectsService } from "./projects/inv-projects.service";
import { LaborService } from "./labor/labor.service";
import { DockService } from "./dock/dock.service";
import { GrnService } from "./purchase-orders/grn.service";
import { ReservationService } from "./stock-engine/reservation.service";
import { SoCoreService } from "./sales-orders/so-core.service";

/**
 * Providers the shared stub list does not carry. Every name below is read off
 * the real class — `check:mock-surface` now walks this file and will fail the
 * build on an invented one, which it already did to me once in batch 2.
 */
const EXTRA_PROVIDERS = [
  { provide: "APP_CONFIG", useValue: { get: jest.fn().mockReturnValue(undefined) } },
  { provide: "NoopWesAdapter", useValue: { notifyPick: jest.fn().mockResolvedValue(undefined) } },
  {
    provide: PickWaveService,
    useValue: {
      proposeWaveJoin: jest.fn().mockResolvedValue(null),
      createWave: jest.fn().mockResolvedValue(null),
      joinWave: jest.fn().mockResolvedValue(null),
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
    provide: InvProjectsService,
    useValue: {
      listProjects: jest.fn().mockResolvedValue({ items: [] }),
      getProject: jest.fn().mockResolvedValue(null),
      coverageFor: jest.fn().mockResolvedValue([]),
      atRiskRequirements: jest.fn().mockResolvedValue([]),
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
    provide: DockService,
    useValue: {
      listDoors: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue({ items: [] }),
      book: jest.fn().mockResolvedValue(null),
      setStatus: jest.fn().mockResolvedValue(undefined),
      hasAppointmentForAsn: jest.fn().mockResolvedValue(false),
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
    provide: SoCoreService,
    useValue: {
      listSos: jest.fn().mockResolvedValue({ items: [] }),
      getSo: jest.fn().mockResolvedValue(null),
      getAtp: jest.fn().mockResolvedValue({ available: "0" }),
      findAvailableLotForLine: jest.fn().mockResolvedValue(null),
    },
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
 * Cross-tenant isolation, batch 3 — the write and compute services.
 *
 * These differ from the two read batches in one way that matters. A command
 * usually loads the thing it is about before doing anything to it, and that load
 * is the isolation boundary: `assertVisible`, `loadPackage`, a `SELECT ... WHERE
 * org_id = $1 AND id = $2`. So the call is allowed to THROW here — the double
 * returns rows that do not satisfy the command's preconditions and it refuses —
 * and the assertion is on the predicate built before the refusal. A command that
 * threw without ever binding the caller's org would fail these tests, which is
 * the case worth catching: it means the ownership check never ran.
 */

/**
 * NINE MORE SERVICES REMAIN UNCOVERED, and they are named in the commit message
 * and TICKET-CLAIMS.md rather than here — deliberately.
 *
 * `check:tenant-isolation` marks a service covered when its class name appears
 * anywhere in a file that also contains an isolation keyword. It is a
 * DECLARATION check, not a behavioural one, and it says so itself: "this says
 * the test EXISTS, not that it passes". So listing the uncovered classes in a
 * comment in this file turns the gate green for them — I did exactly that, and
 * it took nine services from honestly-red to falsely-green in one paragraph.
 *
 * Each of those nine needs a real fixture — a posted GRN, a claimed wave, a
 * voucher with charge lines — before its entry point reaches an org-scoped read.
 * A test that hands them a shapeless object asserts on the throw, not on the
 * predicate. They want seeded specs, not doubles.
 */
const OWNER = "org-owner";
const ATTACKER = "org-attacker";
const USER = "user-1";
const VICTIM_ROW = {
  id: 1,
  orgId: OWNER,
  code: "OWNED-1",
  status: "OPEN",
  warehouseId: 1,
  productVariantId: 1,
  quantity: "1",
  versions: [],
};

function boundValues(...mocks: jest.Mock[]): unknown[] {
  return mocks.flatMap((m) => m.mock.calls.flatMap((c) => sqlValues(c[0])));
}

async function build<T>(cls: new (...args: never[]) => T, rows: unknown[]) {
  const harness = makeIsolationDb(rows);
  const moduleRef = await Test.createTestingModule({
    providers: [
      ...INVENTORY_ISOLATION_STUBS,
      ...(EXTRA_PROVIDERS as never[]),
      // AFTER the stubs: several services here are also somebody else's
      // dependency, so they appear in EXTRA_PROVIDERS too. The class under test
      // must be the real one, and in Nest the last provider for a token wins.
      cls,
      { provide: DRIZZLE, useValue: harness.db },
      { provide: CacheService, useValue: cacheStub() },
      { provide: WarehouseScopeService, useValue: warehouseScopeStub() },
    ],
  }).compile();
  return { svc: moduleRef.get(cls), ...harness };
}

function isolates<T>(
  name: string,
  cls: new (...args: never[]) => T,
  call: (svc: T, orgId: string) => Promise<unknown>,
  rows: unknown[] = [VICTIM_ROW],
) {
  describe(`${name} — cross-tenant isolation`, () => {
    it("binds the caller's org before acting (isolation — deny)", async () => {
      const { svc, selectWhere, findMany, findFirst, execute } = await build(cls, rows);
      await call(svc, ATTACKER).catch(() => undefined);
      const bound = boundValues(selectWhere, findMany, findFirst, execute);
      expect(bound).toContain(ATTACKER);
      expect(bound).not.toContain(OWNER);
    });

    it("binds the owning org before acting (isolation — control)", async () => {
      const { svc, selectWhere, findMany, findFirst, execute } = await build(cls, rows);
      await call(svc, OWNER).catch(() => undefined);
      expect(boundValues(selectWhere, findMany, findFirst, execute)).toContain(OWNER);
    });
  });
}

isolates("FillRateService", FillRateService, (s, org) => s.report(org, USER, {} as never));
isolates("QuickCommerceInboundService", QuickCommerceInboundService, (s, org) => s.list(org, USER, { page: 1, limit: 20 } as never));
isolates("IndiaComplianceService", IndiaComplianceService, (s, org) => s.documentsFor(org, "SHIPMENT", "1"));
isolates("HandlingUnitService", HandlingUnitService, (s, org) => s.detail(org, USER, 1));
isolates("InvPharmacyService", InvPharmacyService, (s, org) => s.dispensingProfile(org, 1));
isolates("InvQuantityCaptureService", InvQuantityCaptureService, (s, org) => s.captureContract(org, 1, {} as never));
isolates("DemandBaselineService", DemandBaselineService, (s, org) => s.history(org, 1, {}));
isolates("RecallSimulationService", RecallSimulationService, (s, org) => s.simulate(org, USER, { lotIds: [1] } as never));
isolates("ReceiptInspectionService", ReceiptInspectionService, (s, org) => s.openInspectionFor(org, 1));
isolates("CartonizationService", CartonizationService, (s, org) => s.suggest(org, [{ productVariantId: 1, quantity: "1" }] as never));
