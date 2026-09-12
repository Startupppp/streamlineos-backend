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
import { AuditExportService } from "./audit-export/audit-export.service";
import { LandedCostService } from "./landed-cost/landed-cost.service";
import { PickWaveService } from "./picking/pick-wave.service";
import { PutawayTaskService } from "./putaway/putaway-task.service";
import { SlottingService } from "./slotting/slotting.service";
import { TransitExitService } from "./stock/transit-exit.service";
import { ChannelPoolService } from "./stock-engine/channel-pool.service";
import { ChannelSnapshotService } from "./channels/channel-snapshot.service";
import { SoCoreService } from "./sales-orders/so-core.service";
import { PutawayService } from "./warehouses/putaway.service";
import { ChannelAdapterRegistry } from "./channels/channel-adapter";

/**
 * Providers `INVENTORY_ISOLATION_STUBS` does not carry. Each names the REAL
 * surface of its class, read from the class — a stub that invents a name is the
 * defect `check:mock-surface` exists to catch, and this file is now in its walk.
 */
const EXTRA_PROVIDERS = [
  {
    provide: SoCoreService,
    useValue: {
      listSos: jest.fn().mockResolvedValue({ items: [] }),
      getSo: jest.fn().mockResolvedValue(null),
      getAtp: jest.fn().mockResolvedValue({ available: "0" }),
      findAvailableLotForLine: jest.fn().mockResolvedValue(null),
    },
  },
  { provide: PutawayService, useValue: { suggest: jest.fn().mockResolvedValue([]) } },
  {
    provide: ChannelAdapterRegistry,
    useValue: {
      register: jest.fn(),
      forChannelType: jest.fn().mockReturnValue({ canPoll: false }),
    },
  },
  { provide: "APP_CONFIG", useValue: { get: jest.fn().mockReturnValue(undefined) } },
];

/**
 * Cross-tenant isolation, batch 2. Same contract as inv-ops-isolation.spec.ts:
 * the double answers the SAME rows to every org, so the only thing that can make
 * one of these pass is the predicate the service built. See that file's header
 * for why it is asserted by bound value rather than by stringifying the clause.
 */

const OWNER = "org-owner";
const ATTACKER = "org-attacker";
const USER = "user-1";
const VICTIM_ROW = { id: 1, orgId: OWNER, code: "OWNED-1", channelId: 1, warehouseId: 1 };
const PAGE = { page: 1, limit: 20 } as never;

function boundValues(...mocks: jest.Mock[]): unknown[] {
  return mocks.flatMap((m) => m.mock.calls.flatMap((c) => sqlValues(c[0])));
}

async function build<T>(cls: new (...args: never[]) => T, rows: unknown[] = [VICTIM_ROW]) {
  const harness = makeIsolationDb(rows);
  const moduleRef = await Test.createTestingModule({
    providers: [
      ...INVENTORY_ISOLATION_STUBS,
      cls,
      { provide: DRIZZLE, useValue: harness.db },
      { provide: CacheService, useValue: cacheStub() },
      { provide: WarehouseScopeService, useValue: warehouseScopeStub() },
      ...(EXTRA_PROVIDERS as never[]),
    ],
  }).compile();
  return { svc: moduleRef.get(cls), ...harness };
}

/** Both directions for one read: the attacker is scoped, and the owner still works. */
function isolates<T>(
  name: string,
  cls: new (...args: never[]) => T,
  call: (svc: T, orgId: string) => Promise<unknown>,
  rows: unknown[] = [VICTIM_ROW],
) {
  describe(`${name} — cross-tenant isolation`, () => {
    it("binds the caller's org into the read (isolation — deny)", async () => {
      const { svc, selectWhere, findMany, findFirst, execute } = await build(cls, rows);
      await call(svc, ATTACKER).catch(() => undefined);
      const bound = boundValues(selectWhere, findMany, findFirst, execute);
      expect(bound).toContain(ATTACKER);
      expect(bound).not.toContain(OWNER);
    });

    it("binds the owning org into the read (isolation — control)", async () => {
      const { svc, selectWhere, findMany, findFirst, execute } = await build(cls, rows);
      await call(svc, OWNER).catch(() => undefined);
      expect(boundValues(selectWhere, findMany, findFirst, execute)).toContain(OWNER);
    });
  });
}

isolates("AuditExportService", AuditExportService, (s, org) => s.list(org, USER, PAGE));
isolates("LandedCostService", LandedCostService, (s, org) => s.listVouchers(org, USER, PAGE));
isolates("PickWaveService", PickWaveService, (s, org) => s.listWaves(org, USER, PAGE));
isolates("PutawayTaskService", PutawayTaskService, (s, org) => s.list(org, USER, PAGE));
isolates("SlottingService", SlottingService, (s, org) => s.listRules(org, USER));
isolates("TransitExitService", TransitExitService, (s, org) => s.listStranded(org, USER, PAGE));
isolates("ChannelPoolService", ChannelPoolService, (s, org) => s.listForChannel(org, USER, 1));
isolates("ChannelSnapshotService", ChannelSnapshotService, (s, org) => s.listDiffs(org, 1, PAGE));
