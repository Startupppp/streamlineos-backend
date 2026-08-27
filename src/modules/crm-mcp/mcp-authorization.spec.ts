import type { AuthResult } from "../access/access.types";
import {
  agentTokenIdOf,
  decideCapabilityAccess,
  narrowTokenScopes,
  type McpAccessFacts,
} from "./mcp-authorization";
import type { McpCapability } from "./mcp-capability";

const PERMISSION = "crm:deals:read";

const capability: McpCapability = {
  name: "crm.deal.read",
  description: "Read one deal by id.",
  permission: PERMISSION,
  mutates: false,
  auditAction: "crm.mcp.deal.read",
  arguments: {},
  invoke: () => Promise.resolve(null),
};

const allowed: AuthResult = { allow: true, scope: "all" };
const forbidden: AuthResult = { allow: false, scope: "none", reason: "FORBIDDEN" };
const noModule: AuthResult = { allow: false, scope: "none", reason: "NO_MODULE" };
const unauthenticated: AuthResult = { allow: false, scope: "none", reason: "UNAUTHENTICATED" };

function facts(overrides: Partial<McpAccessFacts> = {}): McpAccessFacts {
  return {
    serverEnabled: true,
    tokenId: 7,
    capability,
    grantedScopes: [PERMISSION],
    authorization: allowed,
    ...overrides,
  };
}

describe("deciding whether one protocol call may proceed", () => {
  it("lets a scoped token through with the scope the access service decided", () => {
    const decision = decideCapabilityAccess(facts({ authorization: { allow: true, scope: "own" } }));

    expect(decision).toEqual({ allow: true, scope: "own" });
  });

  it("refuses everything when the tenant has not enabled the server", () => {
    const decision = decideCapabilityAccess(facts({ serverEnabled: false }));

    expect(decision).toEqual({
      allow: false,
      refusal: "server-disabled",
      message: expect.any(String),
    });
  });

  /**
   * A tenant with the server off must not be able to tell a real capability
   * name from a made-up one — otherwise the disabled surface is a working
   * enumeration oracle for what the CRM can do.
   */
  it("gives the same refusal for a real and an invented capability while it is off", () => {
    const real = decideCapabilityAccess(facts({ serverEnabled: false }));
    const invented = decideCapabilityAccess(facts({ serverEnabled: false, capability: undefined }));

    expect(invented).toEqual(real);
  });

  it("refuses a request that did not arrive on an agent token", () => {
    const decision = decideCapabilityAccess(facts({ tokenId: null }));

    expect(decision).toMatchObject({ allow: false, refusal: "not-an-agent-token" });
  });

  it("tells an out-of-scope token apart from an under-permissioned owner", () => {
    const outOfScope = decideCapabilityAccess(facts({ grantedScopes: [] }));
    const underPermissioned = decideCapabilityAccess(facts({ authorization: forbidden }));

    // Two different screens fix these, so they must not report as one thing.
    expect(outOfScope).toMatchObject({ allow: false, refusal: "out-of-token-scope" });
    expect(underPermissioned).toMatchObject({ allow: false, refusal: "forbidden" });
  });

  it("reports a disabled module as a disabled module", () => {
    const decision = decideCapabilityAccess(facts({ authorization: noModule }));

    expect(decision).toMatchObject({ allow: false, refusal: "module-disabled" });
  });

  it("reports an unauthenticated context as unauthenticated", () => {
    const decision = decideCapabilityAccess(facts({ authorization: unauthenticated }));

    expect(decision).toMatchObject({ allow: false, refusal: "unauthenticated" });
  });

  /**
   * The property that matters more than any single row above: this function
   * can only ever REMOVE an allowance. If every combination of facts that ends
   * in `allow: true` also had `authorization.allow`, then no bug here can grant
   * anything the platform's own access service did not already grant.
   */
  it("never allows what the access service refused, under any combination of facts", () => {
    const allowances: McpAccessFacts[] = [];

    for (const serverEnabled of [true, false])
      for (const tokenId of [7, null])
        for (const held of [capability, undefined])
          for (const grantedScopes of [[PERMISSION], [], ["crm:leads:view"]])
            for (const authorization of [allowed, forbidden, noModule, unauthenticated]) {
              const input = { serverEnabled, tokenId, capability: held, grantedScopes, authorization };
              if (decideCapabilityAccess(input).allow) allowances.push(input);
            }

    expect(allowances.length).toBeGreaterThan(0);
    expect(allowances.every((input) => input.authorization.allow)).toBe(true);
    expect(allowances.every((input) => input.serverEnabled)).toBe(true);
    expect(allowances.every((input) => input.tokenId !== null)).toBe(true);
    expect(
      allowances.every((input) => input.grantedScopes.includes(PERMISSION)),
    ).toBe(true);
  });
});

describe("narrowing what a credential may exercise", () => {
  it("gives an unscoped credential exactly its grant, never everything", () => {
    expect(narrowTokenScopes(null, ["crm:deals:read"])).toEqual(["crm:deals:read"]);
  });

  it("leaves a token with no grant able to do nothing, rather than anything", () => {
    // Null would mean unrestricted to `AccessService.scopeFor`. An empty list
    // means every key resolves to scope "none", which is the right answer for a
    // credential nobody has scoped yet.
    expect(narrowTokenScopes(null, [])).toEqual([]);
  });

  it("cannot widen a credential that already carried its own scopes", () => {
    const held = ["crm:deals:read"];
    const granted = ["crm:deals:read", "crm:activities:manage"];

    expect(narrowTokenScopes(held, granted)).toEqual(["crm:deals:read"]);
  });

  it("drops a duplicate rather than counting it twice", () => {
    expect(narrowTokenScopes(null, ["crm:deals:read", "crm:deals:read"])).toEqual([
      "crm:deals:read",
    ]);
  });
});

describe("recognising the credential behind a resolved context", () => {
  it("finds the token an agent request arrived on", () => {
    expect(agentTokenIdOf("agent-token:42")).toBe(42);
  });

  it("does not mistake a personal access token or a web session for one", () => {
    expect(agentTokenIdOf("pat:42")).toBeNull();
    expect(agentTokenIdOf("session-abc")).toBeNull();
    expect(agentTokenIdOf("agent-token:abc")).toBeNull();
    expect(agentTokenIdOf("agent-token:-1")).toBeNull();
    expect(agentTokenIdOf("agent-token:0")).toBeNull();
  });
});
