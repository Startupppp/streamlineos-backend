import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { agentTokens, auditLogs, crmMcpSettings, orgModules } from "src/db/schema";
import { AuditService } from "src/common/audit/audit.service";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.types";
import { runWithTenantContext, withTenant } from "src/common/tenant";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P1-04, against the table rather than against the spy.
 *
 * `crm-mcp-audit.spec.ts` asserts the shape of what an entry carries, and
 * `crm-mcp.service.spec.ts` asserts that `logCritical` is called. Both passed
 * throughout the defect this file exists for: the three refusal entries were
 * written into the request's own transaction, and `TenantContextInterceptor`
 * rolled that transaction back as the refusal was thrown through it. The row
 * existed, was visible to the transaction that wrote it, and was gone by the
 * time the 403 reached the caller — so a test that watches the method can only
 * ever confirm the half that was never broken.
 *
 * Every assertion here reads `audit_logs` on the owner connection after the
 * response has been delivered. Inside a test, deliberately: the fixture's
 * teardown deletes the org's audit rows, so a query written after the suite
 * finds nothing whatever the code does and would have passed against the bug.
 */
describe(`${SEEDED_HARNESS} CRM MCP audit rows`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let sessionToken: string;
  let repUserId: string;

  const rawAgentToken = `slos_${randomBytes(24).toString("hex")}`;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    fixture = await seedOrg(seeded.seedDb)
      .addMember("rep", {
        permissionKeys: ["crm:deals:read", "party:parties:view"],
      })
      .build();

    await seeded.seedDb
      .insert(orgModules)
      .values([{ orgId: fixture.orgId, moduleKey: "crm", enabled: true }]);

    await seeded.seedDb
      .insert(crmMcpSettings)
      .values({ organizationId: fixture.orgId, enabled: true })
      .onConflictDoNothing();

    const rep = fixture.members.rep;
    if (!rep) throw new Error("seed: member 'rep' missing");
    repUserId = rep.userId;
    sessionToken = await signSeededToken(rep.userId, fixture.orgId);

    /** Scoped to deals alone, so the party tools are refused on the ceiling. */
    await seeded.seedDb.insert(agentTokens).values({
      orgId: fixture.orgId,
      userId: rep.userId,
      issuerMembershipId: rep.membershipId,
      scopes: ["crm:deals:read"],
      name: "seeded mcp audit agent",
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

  /** Each test asserts on rows it caused, so it starts from none. */
  beforeEach(async () => {
    await seeded.seedDb
      .delete(auditLogs)
      .where(eq(auditLogs.orgId, fixture.orgId));
  });

  /** The owner connection, so RLS cannot be what makes a row look absent. */
  async function auditRows(action: string) {
    return seeded.seedDb
      .select({
        action: auditLogs.action,
        userId: auditLogs.userId,
        targetId: auditLogs.targetId,
        targetType: auditLogs.targetType,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.orgId, fixture.orgId), eq(auditLogs.action, action)),
      );
  }

  function asAgent(method: "get" | "post", path: string) {
    const agent = request(seeded.app.getHttpServer());
    return agent[method](path).set("Authorization", `Bearer ${rawAgentToken}`);
  }

  it("leaves a row behind when a scoped token is refused a tool", async () => {
    await asAgent("post", "/crm/mcp/call")
      .send({ name: "crm_list_parties", arguments: { search: "acme" } })
      .expect(403);

    const rows = await auditRows("crm.mcp.tool_refused");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: repUserId,
      targetId: "crm_list_parties",
      targetType: "crm_mcp_tool",
    });
    /** The entry has to say what was asked for and why it was refused. */
    expect(rows[0]?.metadata).toMatchObject({
      requiredPermission: "party:parties:view",
      arguments: { search: { redacted: true, length: 4 } },
    });
  });

  it("leaves a row behind when an agent probes for a tool that does not exist", async () => {
    await asAgent("post", "/crm/mcp/call")
      .send({ name: "crm_drop_everything", arguments: {} })
      .expect(404);

    const rows = await auditRows("crm.mcp.tool_unknown");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      requestedTool: "crm_drop_everything",
    });
  });

  it("leaves a row behind when the organisation has agent access switched off", async () => {
    await seeded.seedDb
      .update(crmMcpSettings)
      .set({ enabled: false })
      .where(eq(crmMcpSettings.organizationId, fixture.orgId));

    try {
      await asAgent("post", "/crm/mcp/call")
        .send({ name: "crm_list_deals", arguments: {} })
        .expect(403);

      const rows = await auditRows("crm.mcp.tool_refused");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({
        reason: "AGENT_ACCESS_DISABLED",
      });
    } finally {
      await seeded.seedDb
        .update(crmMcpSettings)
        .set({ enabled: true })
        .where(eq(crmMcpSettings.organizationId, fixture.orgId));
    }
  });

  /**
   * The other direction. Moving the refusal entries out of the request's
   * transaction must not have moved the successful one out of the table.
   */
  it("still leaves a row behind when a tool runs", async () => {
    await request(seeded.app.getHttpServer())
      .post("/crm/mcp/call")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ name: "crm_list_parties", arguments: { limit: 5 } })
      .expect(201);

    const rows = await auditRows("crm.mcp.tool_executed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetId: "crm_list_parties" });
    expect(rows[0]?.metadata).toMatchObject({ resultCount: expect.any(Number) });
  });

  /**
   * The guarantee itself, one layer below CRM, because the next surface that
   * audits a refusal will reach for the same two methods.
   *
   * Both entries are written from inside one tenant transaction and that
   * transaction is then rolled back, which is exactly what an exception thrown
   * out of a handler does. `logCritical` is meant to go with it — an audit of a
   * mutation that never committed would be a record of something that did not
   * happen. `logCriticalOutsideTransaction` is meant to survive.
   */
  it("keeps an out-of-transaction entry through a rollback and drops an in-transaction one", async () => {
    const db = seeded.app.get<Db>(DRIZZLE, { strict: false });
    const audit = seeded.app.get(AuditService, { strict: false });
    const orgId = fixture.orgId;

    await expect(
      withTenant(db, { orgId, audience: "INTERNAL" }, (tx) =>
        runWithTenantContext({ orgId, audience: "INTERNAL", tx }, async () => {
          await audit.logCritical({
            action: "test.audit.in_transaction",
            userId: repUserId,
            orgId,
          });
          await audit.logCriticalOutsideTransaction({
            action: "test.audit.outside_transaction",
            userId: repUserId,
            orgId,
          });
          throw new ForbiddenException("refused after both entries were written");
        }),
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(await auditRows("test.audit.outside_transaction")).toHaveLength(1);
    expect(await auditRows("test.audit.in_transaction")).toHaveLength(0);
  });
});
