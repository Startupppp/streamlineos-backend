import { Test } from "@nestjs/testing";
import type { AuditEntry } from "../../common/audit/audit.service";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { moduleAvailabilityResolver } from "../../common/rbac/module-availability";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";
import { AccessService } from "../access/access.service";
import type { DataScope } from "../access/access.types";
import { ActivitiesService } from "../activities/activities.service";
import { AttributionService } from "../attribution/attribution.service";
import { DealsService } from "../deals/deals.service";
import { CrmMcpEnablementService } from "./crm-mcp-enablement.service";
import { CrmMcpGrantsService } from "./crm-mcp-grants.service";
import { CrmMcpService } from "./crm-mcp.service";

/**
 * What the executor actually does to a request, with the database replaced and
 * the access rule kept.
 *
 * The one seam is the storage. `scopeFor` below reproduces the production rule
 * from `access.service.ts` exactly — the `tokenScopes` gate, then the org-owner
 * shortcut, then the resolved grants — which is the same substitution
 * `authorize.spec.ts` makes and for the same reason: the claim under test is
 * what this module hands the access service and what it does with the answer,
 * not whether the access service is right. `authorize.spec.ts` owns that.
 *
 * The ordering of the two is the whole point of ticket 19's second criterion,
 * so it is worth stating: the token gate is checked BEFORE `isOrgOwner`. A
 * token issued by an organisation owner is scoped by its grant like any other,
 * which is exactly what an unscoped agent token was not.
 */

interface RecordedActor {
  readonly actor: unknown;
  readonly source: string;
}

describe("one MCP call, from token to service", () => {
  let mcp: CrmMcpService;

  let serverEnabled: boolean;
  let tokenGrants: string[];
  let ownerScopes: Map<string, DataScope>;
  let contextsSeen: CurrentUserContext[];
  let audited: AuditEntry[];
  let activityWrites: RecordedActor[];

  const owner: CurrentUserContext = {
    userId: "user-1",
    orgId: "org-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "agent-token:9",
    tokenScopes: null,
  };

  beforeEach(async () => {
    serverEnabled = true;
    tokenGrants = [];
    ownerScopes = new Map();
    contextsSeen = [];
    audited = [];
    activityWrites = [];

    const access = {
      scopeFor: (user: CurrentUserContext, key: string): Promise<DataScope> => {
        contextsSeen.push(user);
        if (
          user.tokenScopes !== null &&
          (!isPersonalTokenPermissionDelegable(key) || !user.tokenScopes.includes(key))
        )
          return Promise.resolve("none");
        if (user.isOrgOwner) return Promise.resolve("all");
        return Promise.resolve(ownerScopes.get(key) ?? "none");
      },
      getModuleState: () => Promise.resolve(true),
      buildModuleAvailabilityResolver: (
        getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
      ) =>
        moduleAvailabilityResolver({
          isCoreModule: () => false,
          getModuleMap,
          getPlanLockedModules: () => Promise.resolve([]),
        }),
    };

    const testing = await Test.createTestingModule({
      providers: [
        CrmMcpService,
        { provide: AccessService, useValue: access },
        {
          provide: CrmMcpEnablementService,
          useValue: { isEnabled: () => Promise.resolve(serverEnabled) },
        },
        {
          provide: CrmMcpGrantsService,
          useValue: { scopesFor: () => Promise.resolve(tokenGrants) },
        },
        {
          provide: AuditService,
          useValue: {
            logCritical: (entry: AuditEntry) => {
              audited.push(entry);
              return Promise.resolve();
            },
          },
        },
        {
          provide: ActivitiesService,
          useValue: {
            timeline: () => Promise.resolve({ entries: [], nextCursor: null }),
            create: (_org: string, actor: unknown, _input: unknown, source: string) => {
              activityWrites.push({ actor, source });
              return Promise.resolve({ activityId: "activity-1" });
            },
          },
        },
        {
          provide: DealsService,
          useValue: {
            getDeal: (_org: string, dealId: number) => Promise.resolve({ id: dealId }),
            listDeals: (
              _org: string,
              _user: string,
              _query: unknown,
              scope: DataScope,
            ) => Promise.resolve({ scopeUsed: scope }),
          },
        },
        { provide: AttributionService, useValue: { report: () => Promise.resolve({}) } },
      ],
    }).compile();

    mcp = testing.get(CrmMcpService);
  });

  it("refuses an organisation owner's token that was granted nothing", async () => {
    const outcome = await mcp.call(owner, "crm.deal.read", { dealId: 1 });

    expect(outcome).toMatchObject({ ok: false, reason: "out-of-token-scope" });
  });

  it("scopes the context it hands the access service, rather than leaving it unrestricted", async () => {
    tokenGrants = ["crm:deals:read"];
    await mcp.call(owner, "crm.deal.read", { dealId: 1 });

    // Null here would mean UNRESTRICTED, which is what `AgentTokenGuard` alone
    // produces and what this module exists to stop reaching the access service.
    expect(contextsSeen.every((context) => context.tokenScopes !== null)).toBe(true);
    expect(contextsSeen[0].tokenScopes).toEqual(["crm:deals:read"]);
  });

  it("reads the deal once the token is scoped for it", async () => {
    tokenGrants = ["crm:deals:read"];
    const outcome = await mcp.call(owner, "crm.deal.read", { dealId: 12 });

    expect(outcome).toEqual({ ok: true, capability: "crm.deal.read", result: { id: 12 } });
  });

  it("passes the service the data scope the access service decided, not a wider one", async () => {
    const member: CurrentUserContext = { ...owner, isOrgOwner: false, role: "MEMBER" };
    ownerScopes.set("crm:deals:read", "own");
    tokenGrants = ["crm:deals:read"];

    const outcome = await mcp.call(member, "crm.deal.list", {});

    expect(outcome).toEqual({
      ok: true,
      capability: "crm.deal.list",
      result: { scopeUsed: "own" },
    });
  });

  it("records a write as the machine it was, naming the token", async () => {
    tokenGrants = ["crm:activities:manage"];
    await mcp.call(owner, "crm.activity.log", { kind: "note", partyId: "party-1", body: "hi" });

    expect(activityWrites).toEqual([
      { actor: { kind: "system", label: "mcp:agent-token:9" }, source: "mcp" },
    ]);
  });

  it("writes one audit row per call, attributed to the token and its owner", async () => {
    tokenGrants = ["crm:deals:read"];
    await mcp.call(owner, "crm.deal.read", { dealId: 3 }, { ipAddress: "10.0.0.1" });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "crm.mcp.deal.read",
      userId: "user-1",
      orgId: "org-1",
      actorUserId: "user-1",
      result: "SUCCESS",
      ipAddress: "10.0.0.1",
      metadata: { protocol: "mcp", capability: "crm.deal.read", agentToken: "agent-token:9" },
    });
  });

  it("audits a refusal as loudly as a success, and says why", async () => {
    const outcome = await mcp.call(owner, "crm.deal.read", { dealId: 3 });

    expect(outcome.ok).toBe(false);
    expect(audited[0]).toMatchObject({
      result: "FAILURE",
      metadata: { refusal: "out-of-token-scope", agentToken: "agent-token:9" },
    });
  });

  it("refuses everything, including a granted capability, when the tenant has not enabled it", async () => {
    serverEnabled = false;
    tokenGrants = ["crm:deals:read"];

    const outcome = await mcp.call(owner, "crm.deal.read", { dealId: 1 });

    expect(outcome).toMatchObject({ ok: false, reason: "server-disabled" });
  });

  it("refuses a caller who is not on an agent token, however many permissions they hold", async () => {
    const webSession: CurrentUserContext = { ...owner, sessionId: "session-abc" };

    const outcome = await mcp.call(webSession, "crm.deal.read", { dealId: 1 });

    // An ambient session would authenticate perfectly well and there would be
    // nothing to scope, nothing to revoke and nothing to attribute.
    expect(outcome).toMatchObject({ ok: false, reason: "not-an-agent-token" });
  });

  it("rejects arguments that do not match the capability, without reaching the service", async () => {
    tokenGrants = ["crm:activities:manage"];

    const outcome = await mcp.call(owner, "crm.activity.log", { kind: "telepathy" });

    expect(outcome).toMatchObject({ ok: false, reason: "invalid-arguments" });
    expect(activityWrites).toEqual([]);
  });

  it("lists only the tools this token can actually call", async () => {
    tokenGrants = ["crm:deals:read"];

    const tools = await mcp.listTools(owner);

    expect(tools.map((tool) => tool.name).sort()).toEqual(["crm.deal.list", "crm.deal.read"]);
  });

  it("lists nothing at all for a token nobody has scoped", async () => {
    const tools = await mcp.listTools(owner);

    expect(tools).toEqual([]);
  });
});
