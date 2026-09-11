/**
 * CRM-P1-16, from the issuer to the guard, in one test.
 *
 * The bug this pins shut was never visible from either side. `AgentTokensService`
 * was right about what it minted — a `slos_` credential in `agent_tokens`,
 * scoped to CRM keys. `JwtAuthGuard` was right about what it admitted — session
 * JWTs and personal access tokens from `user_api_tokens`. `CrmMcpController`
 * carried the second of those and the CRM MCP settings page issued the first,
 * so the credential the product handed out for this server was refused 401 by
 * that server, before scopes were ever considered. Every unit test on either
 * half passed throughout.
 *
 * So this file refuses to look at either half alone. It calls the real
 * `AgentTokensService.create`, takes the raw token that came back, and presents
 * it over HTTP to the real `CrmMcpController` behind the real `JwtAuthGuard`
 * registered the way `app.module.ts` registers it — as an `APP_GUARD`, which is
 * the detail that made this impossible to fix with a second stacked guard: Nest
 * runs global guards before controller guards, so `JwtAuthGuard` answers first
 * no matter what a controller mounts after it.
 *
 * Nothing about the credential is restated here. The hash the guard looks up is
 * the hash the issuer wrote; if the two ever disagree about prefix, hashing or
 * storage, the request 401s and this file goes red.
 *
 * Stubbed: the database rows, the membership lookup, module entitlement, and
 * the CRM services the tools call. The real `AccessService.scopeFor` — the code
 * that applies a token's ceiling — is not stubbed. It is half of what is being
 * tested.
 */
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { CrmMcpController } from "./crm-mcp.controller";
import { CrmMcpService } from "./crm-mcp.service";
import { AgentTokensService } from "../../agent-access/agent-tokens.service";
import { AccessService } from "../../access/access.service";
import { EntitlementsService } from "../../access/entitlements.service";
import { AuditService } from "../../../common/audit/audit.service";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import { MembershipStateService } from "../../../common/auth/membership-state.service";
import type { MembershipState } from "../../../common/auth/membership-state.service";
import { REDIS } from "../../../common/cache/cache.service";
import type { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { PartyService } from "../../party/party.service";
import { DealsService } from "../../deals/deals.service";
import { ActivitiesService } from "../../activities/activities.service";
import { ReportingService } from "../../reporting/reporting.service";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";
import { CrmMcpSettingsService } from "./crm-mcp-settings.service";
import { AccessVersionCache } from "../../access/access-version-cache";
import { membershipStubFromDb } from "../../../../test/helpers/membership-state-stub";
import { AuthContextFactory } from "../../../common/auth/auth-context.factory";
import { JwtKeyringService } from "../../../common/auth/jwt-keyring.service";
import { makeAuthContextFactory } from "../../../../test/helpers/module-guard-context";

const DEAL_KEY = "crm:deals:read";
const PARTY_KEY = "party:parties:view";

const USER_ID = "user-mcp-1";
const ORG_ID = "org-mcp-1";
const MEMBERSHIP_ID = 31;
const TOKEN_ID = 77;

/**
 * The hash the guard is actually looking up.
 *
 * `withPublicToken` sets `app.public_token` to the sha256 of the presented
 * credential immediately before the select, so the double can answer the way
 * Postgres would — by hash — instead of returning its one row to anybody who
 * asks. Without this the "no row backs it" case passed while proving only that
 * the mock was indiscriminate.
 */
function hashInSql(node: unknown, depth = 0): string | null {
  if (depth > 6 || node === null || node === undefined) return null;
  if (typeof node === "string") return /^[0-9a-f]{64}$/.test(node) ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = hashInSql(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = hashInSql(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const ACTIVE_MEMBERSHIP: MembershipState = {
  active: true,
  isOwner: false,
  role: "MEMBER",
  membershipId: MEMBERSHIP_ID,
};

/**
 * A route that did NOT opt in, mounted in the same app.
 *
 * `@AllowAgentToken()` is what widens this surface, and a widening nobody can
 * see the edge of is not one worth having. This controller is the edge.
 */
@Controller("not-opted-in")
class NotOptedInController {
  @AuthorizedInService("nothing — this route exists to be refused")
  @Get("thing")
  thing() {
    return { reached: true };
  }
}

describe("CRM MCP agent token, issuer to guard", () => {
  let app: INestApplication;
  let issuedToken: string;

  /**
   * What the *person* behind the token holds, at the broadest scope.
   *
   * Deliberately includes the party key. When the party tool is refused below,
   * the reason cannot be "the user cannot read parties" — the user can. The
   * only thing standing between the token and that tool is its own ceiling.
   */
  const heldByUser = new Map<string, DataScope>([
    [DEAL_KEY, "all"],
    [PARTY_KEY, "all"],
  ]);

  /** Populated by the real issuer, read by the real guard. Never hand-written. */
  let storedRow: {
    id: number;
    userId: string;
    orgId: string;
    issuerMembershipId: number;
    scopes: string[];
    tokenHash: string;
  } | null = null;

  /*
   * The real method names. These were `list` and `findOne`, which no service
   * has — the handler probed for them, never found them, and fell through to
   * the methods below with arguments nothing type-checked.
   */
  const deals = { listDeals: jest.fn(), getDeal: jest.fn() };
  const parties = { listParties: jest.fn(), getParty: jest.fn() };

  beforeAll(async () => {
    /**
     * One database double, serving the issuer's insert and the guard's lookup.
     *
     * `transaction` must invoke its callback: `withPublicToken` and
     * `runInTenantTransaction` both go through it, and a bare `jest.fn()`
     * returns undefined, which the guard reads as "no such token" — every
     * assertion below would then pass for the wrong reason.
     */
    let presentedHash: string | null = null;
    const mockDb = {
      execute: jest.fn((statement: unknown) => {
        const found = hashInSql(statement);
        if (found) presentedHash = found;
        return Promise.resolve([]);
      }),
      transaction: jest.fn(),
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP_ID }),
        },
      },
      // The issuer counts active tokens; the guard selects one by hash. Both
      // land here, told apart by whether `.limit()` is called.
      // Implementation assigned below, once `presentedHash` is in scope.
      select: jest.fn(),
      insert: jest.fn(() => ({
        values: jest.fn((row: Record<string, unknown>) => {
          storedRow = {
            id: TOKEN_ID,
            userId: row.userId as string,
            orgId: row.orgId as string,
            issuerMembershipId: row.issuerMembershipId as number,
            scopes: row.scopes as string[],
            tokenHash: row.tokenHash as string,
          };
          return {
            returning: jest.fn().mockResolvedValue([
              {
                id: TOKEN_ID,
                name: row.name,
                tokenPrefix: row.tokenPrefix,
                scopes: row.scopes,
                expiresAt: row.expiresAt,
                createdAt: new Date(),
              },
            ]),
          };
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

    // The issuer's active-token count reads `.where(...)` as a promise, with no
    // `.limit()`; the guard's lookup chains `.limit()`. One `where` serves both.
    const selectImpl = () => {
      const whereResult = Object.assign(
        Promise.resolve([{ total: 0 }]) as unknown as Promise<
          Array<{ total: number }>
        > & { limit: jest.Mock },
        {
          limit: jest
            .fn()
            .mockImplementation(async () =>
              storedRow && storedRow.tokenHash === presentedHash
                ? [storedRow]
                : [],
            ),
        },
      );
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(whereResult),
        }),
      };
    };
    mockDb.select.mockImplementation(selectImpl);

    const cache = {
      cached: jest.fn(),
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    const entitlements = {
      isCoreModule: jest.fn().mockReturnValue(false),
      isModuleEnabled: jest.fn().mockResolvedValue(true),
      getModuleState: jest.fn().mockResolvedValue(true),
      getModuleMap: jest.fn().mockResolvedValue({ crm: true, party: true }),
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

    const access = new AccessService(
      mockDb as unknown as Db,
      cache,
      entitlements,
      makeMfaPolicyStub(),
      new AccessVersionCache(mockDb as unknown as Db, cache),
      membershipStubFromDb(mockDb),
    );
    jest
      .spyOn(access, "resolveUserPermissions")
      .mockImplementation(async () => new Map(heldByUser));

    const mcpSettings = { isEnabled: jest.fn().mockResolvedValue(true) };
    const audit = {
      log: jest.fn(),
      logCritical: jest.fn().mockResolvedValue(undefined),
      logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [CrmMcpController, NotOptedInController],
      providers: [
        Reflector,
        CrmMcpService,
        AgentTokensService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: DRIZZLE, useValue: mockDb },
        { provide: REDIS, useValue: null },
        { provide: AccessService, useValue: access },
        { provide: AuditService, useValue: audit },
        {
          provide: MembershipStateService,
          useValue: {
            resolve: jest.fn().mockResolvedValue(ACTIVE_MEMBERSHIP),
            isAccountActive: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: PartyService, useValue: parties },
        { provide: DealsService, useValue: deals },
        { provide: ActivitiesService, useValue: { timeline: jest.fn() } },
        { provide: ReportingService, useValue: { runAdHoc: jest.fn() } },
        /**
         * Agent access is on unless a test says otherwise.
         *
         * CRM-P2-09 added a tenant switch in front of every tool. Defaulting
         * the double to off would have turned every assertion in this file into
         * a test of the switch instead of a test of what it guards.
         */
        { provide: CrmMcpSettingsService, useValue: mcpSettings },
        // main's JwtAuthGuard and authorize() build an AuthContext per request;
        // the agent-token path is handled before any JWT, so the keyring is inert.
        { provide: AuthContextFactory, useValue: makeAuthContextFactory() },
        {
          provide: JwtKeyringService,
          useValue: {
            isReady: () => true,
            signToken: jest.fn(),
            verifyToken: jest.fn().mockRejectedValue(new Error("not a JWT")),
          },
        },
      ],
    }).compile();

    // The credential under test, minted by the code the settings page calls.
    const issuer = moduleRef.get(AgentTokensService);
    const created = await issuer.create(USER_ID, ORG_ID, {
      name: "Sales desk agent",
      scopes: [DEAL_KEY],
    });
    issuedToken = created.token;

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    deals.listDeals.mockResolvedValue({ items: [{ id: 1, name: "Big Deal" }] });
    parties.listParties.mockResolvedValue({ data: [{ id: "p1" }] });
  });

  function withToken(method: "get" | "post", path: string) {
    const agent = request(app.getHttpServer());
    return agent[method](path).set("Authorization", `Bearer ${issuedToken}`);
  }

  it("mints the credential the settings page mints", () => {
    // If the issuer ever changes prefix, every assertion below still holds —
    // they go through the real guard — but this states the shape plainly so a
    // reader knows which credential class is under test.
    expect(issuedToken.startsWith("slos_")).toBe(true);
    expect(storedRow?.scopes).toEqual([DEAL_KEY]);
  });

  /**
   * The regression itself. Before `@AllowAgentToken()`, this was 401.
   */
  it("admits the issued token at /crm/mcp/tools", async () => {
    const res = await withToken("get", "/crm/mcp/tools");
    expect(res.status).toBe(200);
  });

  it("offers the token only the tools inside its own scopes", async () => {
    const res = await withToken("get", "/crm/mcp/tools").expect(200);
    const names = (res.body.tools as Array<{ name: string }>).map((t) => t.name);

    expect(names).toEqual(["crm_list_deals", "crm_get_deal"]);
    expect(names).not.toContain("crm_list_parties");
  });

  it("runs a deal tool for a token scoped to crm:deals:read", async () => {
    const res = await withToken("post", "/crm/mcp/call")
      .send({ name: "crm_list_deals", arguments: { limit: 5 } })
      .expect(201);

    expect(deals.listDeals).toHaveBeenCalled();
    expect(res.body.content[0].text).toContain("Big Deal");
  });

  it("refuses a party tool with 403, though the token's own user holds the key at scope all", async () => {
    expect(heldByUser.get(PARTY_KEY)).toBe("all");

    await withToken("post", "/crm/mcp/call")
      .send({ name: "crm_list_parties", arguments: {} })
      .expect(403);

    expect(parties.listParties).not.toHaveBeenCalled();
  });

  it("refuses with 403 rather than 402, so the client is not told to buy a module", async () => {
    // 402 is ModuleDisabledException, and the frontend's EntitlementGate keys
    // its upgrade prompt on it. A ceiling refusal is not an upsell.
    const res = await withToken("post", "/crm/mcp/call").send({
      name: "crm_list_parties",
      arguments: {},
    });
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(402);
  });

  it("still refuses the same credential on a route that did not opt in", async () => {
    await request(app.getHttpServer())
      .get("/not-opted-in/thing")
      .set("Authorization", `Bearer ${issuedToken}`)
      .expect(401);
  });

  it("refuses a well-formed slos_ credential that no row backs", async () => {
    await request(app.getHttpServer())
      .get("/crm/mcp/tools")
      .set("Authorization", `Bearer slos_${"f".repeat(48)}`)
      .expect(401);
  });
});
