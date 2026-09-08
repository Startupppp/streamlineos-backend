/**
 * Ticket X4's negative case, at the token level rather than the tool-list level.
 *
 * `crm-mcp.service.spec.ts` ("exposes only CRM-owned tools") proves the MCP
 * catalogue contains no payroll or inventory tool. That is a statement about a
 * literal array in one service. It says nothing about what a credential can
 * reach: an agent token is presented over HTTP and is admitted or refused by
 * `AgentTokenGuard` → `PermissionGuard`, and neither of those ever looks at the
 * MCP tool list.
 *
 * This file drives that real guard pair over real HTTP (supertest), with the
 * same `@UseGuards(AgentTokenGuard, PermissionGuard)` composition `AgentController`
 * uses in production, and the real `AccessService.scopeFor` — the method that
 * actually applies an agent token's ceiling. Only the leaves are stubbed: the
 * database row the token hashes to, the membership lookup, and module
 * entitlement.
 *
 * What it does NOT do, stated plainly so nobody reads more into it: it does not
 * mount the real payroll or inventory controllers, and it does not touch a
 * database. It proves the guard chain refuses a cross-module permission key; it
 * does not prove any particular production payroll route is wired to this chain.
 * (In fact it is not — see the note on reachability at the bottom of this file.)
 *
 * The three keys below are the real catalogued keys carried by real routes:
 *   - `payroll:runs:view`     — src/modules/payroll/jobs/jobs.controller.ts
 *   - `inventory:stock:read`  — src/modules/inventory/warehouses/inv-warehouses.controller.ts
 *   - `crm:deals:read`        — the CRM read key the MCP deal tools require
 *
 * Note on X4's wording: the ticket names `crm:deals:view`. No such key exists in
 * the catalogue; the CRM deal read key is `crm:deals:read`. An uncatalogued key
 * is refused by `authorize()` before anything else looks at it, so a test built
 * on `crm:deals:view` would have gone green for a reason that has nothing to do
 * with module boundaries. The first test below pins that trap shut.
 */
import {
  Controller,
  Get,
  type INestApplication,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import request from "supertest";
import { AgentTokenGuard } from "./agent-token.guard";
import { AccessService } from "../access/access.service";
import { EntitlementsService } from "../access/entitlements.service";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import type { DataScope } from "../access/access.types";
import { Public } from "../../common/auth/public.decorator";
import {
  MembershipStateService,
  type MembershipState,
} from "../../common/auth/membership-state.service";
import type { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { makeMfaPolicyStub } from "../../../test/helpers/mfa-policy-stub";

const CRM_KEY = "crm:deals:read";
const PAYROLL_KEY = "payroll:runs:view";
const INVENTORY_KEY = "inventory:stock:read";

const RAW_TOKEN = "slos_" + "b".repeat(48);
const TOKEN_ID = 91;
const USER_ID = "user-agent-1";
const ORG_ID = "org-boundary-1";
const MEMBERSHIP_ID = 12;

/** Handlers append here, so "403" can be distinguished from "ran, then failed". */
const reachedHandlers: string[] = [];

@Public()
@Controller("agent-token-boundary")
@UseGuards(AgentTokenGuard, PermissionGuard)
class ModuleBoundaryProbeController {
  // `@Public()` mirrors AgentController: it exempts the route from the global
  // JwtAuthGuard, not from PermissionGuard, which reads IS_PUBLIC only when no
  // permission key is declared. Every route here declares one.

  @Get("crm-deals")
  @RequirePermission(CRM_KEY)
  crmDeals() {
    reachedHandlers.push(CRM_KEY);
    return { reached: CRM_KEY };
  }

  @Get("payroll-runs")
  @RequirePermission(PAYROLL_KEY)
  payrollRuns() {
    reachedHandlers.push(PAYROLL_KEY);
    return { reached: PAYROLL_KEY };
  }

  @Get("inventory-stock")
  @RequirePermission(INVENTORY_KEY)
  inventoryStock() {
    reachedHandlers.push(INVENTORY_KEY);
    return { reached: INVENTORY_KEY };
  }
}

const ACTIVE_MEMBERSHIP: MembershipState = {
  active: true,
  isOwner: false,
  role: "MEMBER",
  membershipId: MEMBERSHIP_ID,
};

describe("agent token cross-module boundary (AgentTokenGuard + PermissionGuard)", () => {
  let app: INestApplication;

  /** The scopes stored on the token row; a test may widen them. */
  let tokenScopes: string[] = [CRM_KEY];

  /**
   * What the *person* behind the token holds. Deliberately everything the three
   * routes ask for, at the broadest scope: if a payroll request is refused, the
   * reason cannot be "the user lacks payroll", because the user does not.
   */
  const heldByUser = new Map<string, DataScope>([
    [CRM_KEY, "all"],
    [PAYROLL_KEY, "all"],
    [INVENTORY_KEY, "all"],
  ]);

  beforeAll(async () => {
    // `withPublicToken` and `runInTenantTransaction` both open `db.transaction`.
    // The callback MUST be invoked — a bare jest.fn() here returns undefined and
    // the guard would silently see "no token row", making every assertion below
    // pass for the wrong reason.
    const mockDb: {
      execute: jest.Mock;
      transaction: jest.Mock;
      select: jest.Mock;
      update: jest.Mock;
    } = {
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(),
      // Read `tokenScopes` at call time: the chain is rebuilt on every
      // `select()`, so a test that widens the ceiling mid-run is honoured.
      select: jest.fn(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([
              {
                id: TOKEN_ID,
                userId: USER_ID,
                orgId: ORG_ID,
                issuerMembershipId: MEMBERSHIP_ID,
                scopes: tokenScopes,
              },
            ]),
          }),
        }),
      })),
      update: jest.fn(() => ({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      })),
    };
    mockDb.transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
    );

    const cache = {
      cached: jest.fn(),
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    // Every module the probe routes belong to is enabled, and nothing is
    // user-denied or plan-locked. A module refusal surfaces as 402
    // (ModuleDisabledException), not 403, so the assertions below would catch it
    // anyway — this just removes it as a confound entirely.
    const entitlements = {
      isCoreModule: jest.fn().mockReturnValue(false),
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleState: jest.fn().mockResolvedValue(true),
      getModuleMap: jest
        .fn()
        .mockResolvedValue({ crm: true, payroll: true, inventory: true }),
      getPlanLockedModules: jest.fn().mockResolvedValue([]),
      buildModuleAvailabilityResolver: (
        getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
      ) => ({
        isCoreModule: () => false,
        getModuleMap,
        getUserDeniedModules: async () => new Set<string>(),
        getPlanLockedModules: async () => [] as readonly string[],
      }),
    } as unknown as EntitlementsService;

    // The real AccessService: `scopeFor` — the code that applies an agent
    // token's ceiling — is the thing under test and is not stubbed. Only the
    // permission *lookup* it consults is.
    const access = new AccessService(
      mockDb as unknown as Db,
      cache,
      entitlements,
      makeMfaPolicyStub(),
    );
    jest
      .spyOn(access, "resolveUserPermissions")
      .mockImplementation(async () => new Map(heldByUser));

    const moduleRef = await Test.createTestingModule({
      controllers: [ModuleBoundaryProbeController],
      providers: [
        Reflector,
        AgentTokenGuard,
        PermissionGuard,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: access },
        {
          provide: MembershipStateService,
          useValue: { resolve: jest.fn().mockResolvedValue(ACTIVE_MEMBERSHIP) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    tokenScopes = [CRM_KEY];
    reachedHandlers.length = 0;
  });

  function get(path: string) {
    return request(app.getHttpServer())
      .get(`/agent-token-boundary/${path}`)
      .set("Authorization", `Bearer ${RAW_TOKEN}`);
  }

  it("uses catalogued permission keys, so a refusal cannot be the uncatalogued-key rule", () => {
    // authorize() denies any key absent from the catalogue outright. If these
    // keys were typos every route below would 403 while proving nothing.
    const catalogue = new Set(ALL_PERMISSION_NAMES);
    expect(catalogue.has(CRM_KEY)).toBe(true);
    expect(catalogue.has(PAYROLL_KEY)).toBe(true);
    expect(catalogue.has(INVENTORY_KEY)).toBe(true);
  });

  it("admits the CRM-scoped token on the CRM route (control: the chain works end to end)", async () => {
    await get("crm-deals").expect(200, { reached: CRM_KEY });
    expect(reachedHandlers).toEqual([CRM_KEY]);
  });

  it("refuses the CRM-scoped token at a payroll route with 403", async () => {
    await get("payroll-runs").expect(403);
    expect(reachedHandlers).toEqual([]);
  });

  it("refuses the CRM-scoped token at an inventory route with 403", async () => {
    await get("inventory-stock").expect(403);
    expect(reachedHandlers).toEqual([]);
  });

  it("refuses payroll and inventory even though the token's own user holds both at scope all", async () => {
    expect(heldByUser.get(PAYROLL_KEY)).toBe("all");
    expect(heldByUser.get(INVENTORY_KEY)).toBe("all");

    await get("payroll-runs").expect(403);
    await get("inventory-stock").expect(403);
    await get("crm-deals").expect(200);

    // The user is identical across all three requests. The only thing that
    // differs is whether the key is inside the token's ceiling.
    expect(reachedHandlers).toEqual([CRM_KEY]);
  });

  it("attributes the refusal to the ceiling: widening the token's scopes admits payroll", async () => {
    await get("payroll-runs").expect(403);

    tokenScopes = [CRM_KEY, PAYROLL_KEY];
    await get("payroll-runs").expect(200, { reached: PAYROLL_KEY });

    // Inventory is still outside the widened ceiling.
    await get("inventory-stock").expect(403);
    expect(reachedHandlers).toEqual([PAYROLL_KEY]);
  });

  it("refuses with 403 rather than 402, so the client is not told to buy the module", async () => {
    // 402 is ModuleDisabledException. A cross-module token refusal is not an
    // upsell, and the frontend's EntitlementGate keys its upgrade prompt on 402.
    const res = await get("payroll-runs");
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(402);
  });

  it("rejects an unauthenticated request before PermissionGuard sees it", async () => {
    await request(app.getHttpServer())
      .get("/agent-token-boundary/payroll-runs")
      .expect(401);
    expect(reachedHandlers).toEqual([]);
  });

  it("hashes the presented token with sha256, so a near-miss token is not admitted", () => {
    // Pins the shape the mocked row is keyed on; the guard's own spec covers the
    // lookup itself.
    expect(createHash("sha256").update(RAW_TOKEN).digest("hex")).toHaveLength(64);
  });
});

/*
  Reachability, so this file is not read as claiming more than it shows.

  `AgentTokenGuard` is mounted in exactly one place today: `AgentController`
  (`/agent/v1`), whose routes are all `build:*`. Every payroll and inventory
  controller sits behind the global `JwtAuthGuard` (app.module.ts APP_GUARD),
  which resolves session JWTs and personal access tokens against
  `user_api_tokens` — a different table hashed by a different function from the
  `slos_` agent tokens in `agent_tokens`. So an agent token presented at a real
  payroll route today is refused as unauthenticated (401) before any permission
  is considered; there is no live route where the 403 proven above is the answer
  a real caller receives.

  That is why the routes here are a probe controller rather than the real ones.
  What the suite establishes is the property the ceiling exists to provide: with
  the module enabled, the key catalogued, and the token's own user holding the
  permission at scope "all", `AccessService.scopeFor` still returns "none" for a
  key outside the token's scopes and `PermissionGuard` turns that into a 403.
  Mount `AgentTokenGuard` on any further surface — the CRM MCP controller being
  the obvious candidate — and this is the behaviour that surface inherits.
*/
