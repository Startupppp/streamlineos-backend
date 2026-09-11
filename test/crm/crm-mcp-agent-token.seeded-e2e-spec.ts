import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentTokens, crmMcpSettings, orgModules } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P1-16, against a real database and the real guard chain.
 *
 * `crm-mcp-agent-token-gap.spec.ts` proves the issuer and the guard agree about
 * the credential, with the database doubled. This file removes the double. The
 * token row is real, `AccessService` is real, `JwtAuthGuard` is the global
 * `APP_GUARD` the application boots with, and the CRM services behind the tools
 * read real rows as `streamline_app` under RLS.
 *
 * The claim is the one the boundary spec said any new mount would inherit: with
 * the CRM module enabled, the keys catalogued, and the token's own user holding
 * `party:parties:view` at scope "all", a token scoped to `crm:deals:read` alone
 * reaches the deal tools and is refused on the party tool. The refusal is
 * attributable to the ceiling and to nothing else — the same user, over a
 * session, gets both.
 */
describe(`${SEEDED_HARNESS} CRM MCP agent tokens`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let sessionToken: string;

  /** The raw credential; only its sha256 is ever stored, as in production. */
  const rawAgentToken = `slos_${randomBytes(24).toString("hex")}`;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    fixture = await seedOrg(seeded.seedDb)
      .addMember("rep", {
        permissionKeys: ["crm:deals:read", "party:parties:view"],
      })
      .build();

    // `crm` is plan-gated, so `authorize` answers NO_MODULE — a 402 — without a
    // row here. Written before the first request, because the module map is
    // cached for 30 s.
    await seeded.seedDb.insert(orgModules).values([
      { orgId: fixture.orgId, moduleKey: "crm", enabled: true },
      /**
       * `build` too, and deliberately.
       *
       * `/agent/v1` is build-owned and its routes are `build:*`. With the module
       * off, a CRM token is refused there with 402 by the module gate, which
       * proves nothing about scopes. Enabled, the request gets past the gate and
       * the only thing left to refuse it is its own ceiling — which is the claim
       * the last test in this file makes.
       */
      { orgId: fixture.orgId, moduleKey: "build", enabled: true },
    ]);

    /**
     * CRM-P2-09. Agent access is off until a tenant turns it on, so a fixture
     * that does not say so is testing the switch rather than the ceiling this
     * file is about. Enabled here, and the last test in the file asserts what
     * happens when it is not.
     */
    await seeded.seedDb
      .insert(crmMcpSettings)
      .values({ organizationId: fixture.orgId, enabled: true })
      .onConflictDoNothing();

    const rep = fixture.members.rep;
    if (!rep) throw new Error("seed: member 'rep' missing");

    sessionToken = await signSeededToken(seeded, rep.userId, fixture.orgId);

    /**
     * The token row as `AgentTokensService.create` writes one: sha256 of the
     * raw credential, bound to the issuing membership, scoped to deals only.
     * `issuerMembershipId` matters — the guard refuses a token whose issuing
     * membership no longer matches the one resolved for the user.
     */
    await seeded.seedDb.insert(agentTokens).values({
      orgId: fixture.orgId,
      userId: rep.userId,
      issuerMembershipId: rep.membershipId,
      scopes: ["crm:deals:read"],
      name: "seeded mcp agent",
      tokenHash: createHash("sha256").update(rawAgentToken).digest("hex"),
      tokenPrefix: rawAgentToken.slice(0, 10),
      expiresAt: null,
    });
  }, 180_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(agentTokens)
        .where(eq(agentTokens.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(orgModules)
        .where(eq(orgModules.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(crmMcpSettings)
        .where(eq(crmMcpSettings.organizationId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  });

  function asAgent(method: "get" | "post", path: string) {
    const agent = request(seeded.app.getHttpServer());
    return agent[method](path).set("Authorization", `Bearer ${rawAgentToken}`);
  }

  function asSession(method: "get" | "post", path: string) {
    const agent = request(seeded.app.getHttpServer());
    return agent[method](path).set("Authorization", `Bearer ${sessionToken}`);
  }

  it("admits the agent token that the CRM MCP settings page issues", async () => {
    // The regression. Before `@AllowAgentToken()` this was 401, because
    // `JwtAuthGuard` reads `user_api_tokens` and this credential lives in
    // `agent_tokens`.
    await asAgent("get", "/crm/mcp/tools").expect(200);
  });

  it("keeps the interactive session working on the same routes", async () => {
    // The other half of the requirement: opting the surface in must not have
    // moved it off the path the settings page itself uses.
    const res = await asSession("get", "/crm/mcp/tools").expect(200);
    const names = (res.body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("crm_list_deals");
    expect(names).toContain("crm_list_parties");
  });

  it("offers the agent token only the tools inside its scopes", async () => {
    const res = await asAgent("get", "/crm/mcp/tools").expect(200);
    const names = (res.body.tools as Array<{ name: string }>).map((t) => t.name);

    expect(names).toEqual(["crm_list_deals", "crm_get_deal"]);
  });

  it("runs a deal tool for a token scoped to crm:deals:read", async () => {
    await asAgent("post", "/crm/mcp/call")
      .send({ name: "crm_list_deals", arguments: { limit: 5 } })
      .expect(201);
  });

  it("refuses the party tool with 403, though the same user reaches it over a session", async () => {
    await asAgent("post", "/crm/mcp/call")
      .send({ name: "crm_list_parties", arguments: {} })
      .expect(403);

    // The control that makes the refusal mean something: identical user,
    // identical route, identical tool — only the credential differs.
    await asSession("post", "/crm/mcp/call")
      .send({ name: "crm_list_parties", arguments: {} })
      .expect(201);
  });

  /**
   * The live route the boundary spec said did not exist.
   *
   * That file proved a CRM-scoped token is refused 403 on a payroll or
   * inventory key, then said plainly that no production route was wired to the
   * chain it drove, so no real caller ever received that 403. `/agent/v1` is
   * such a route: build-owned, mounting `AgentTokenGuard`, and reachable by
   * this credential. With `build` enabled above, the module gate is satisfied
   * and the refusal below is the ceiling's alone.
   */
  it("refuses the CRM-scoped token on a live build route, on the ceiling and not the module", async () => {
    const res = await asAgent("get", "/agent/v1/me");
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(402);
  });

  it("refuses a revoked token", async () => {
    await seeded.seedDb
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(eq(agentTokens.orgId, fixture.orgId));

    await asAgent("get", "/crm/mcp/tools").expect(401);

    await seeded.seedDb
      .update(agentTokens)
      .set({ revokedAt: null })
      .where(eq(agentTokens.orgId, fixture.orgId));
  });

  /**
   * CRM-P2-09. Every gate above answers "may this caller run this tool". None
   * of them answers whether the organisation wants a machine touching its
   * customer records at all, and until the switch existed the answer was yes
   * for every tenant with CRM, whether or not anybody there had decided it.
   *
   * The token here is valid, unrevoked, correctly scoped and inside an enabled
   * module. It is refused anyway, and the two refusals stay distinguishable:
   * the scoped-token 403 above names a permission, this one names the
   * organisation's decision.
   */
  it("refuses a perfectly good token when the organisation has agent access off", async () => {
    await seeded.seedDb
      .update(crmMcpSettings)
      .set({ enabled: false })
      .where(eq(crmMcpSettings.organizationId, fixture.orgId));

    /** An empty catalogue, because the honest answer to "what may I call" is nothing. */
    const tools = await asAgent("get", "/crm/mcp/tools").expect(200);
    expect((tools.body.data ?? tools.body).tools).toEqual([]);

    const called = await asAgent("post", "/crm/mcp/call").send({
      name: "crm_list_deals",
      arguments: {},
    });
    expect(called.status).toBe(403);
    expect(JSON.stringify(called.body)).toMatch(/switched off for this organisation/i);

    await seeded.seedDb
      .update(crmMcpSettings)
      .set({ enabled: true })
      .where(eq(crmMcpSettings.organizationId, fixture.orgId));
  });
});
