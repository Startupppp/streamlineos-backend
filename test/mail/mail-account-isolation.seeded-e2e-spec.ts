import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { userIntegrationConnections } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * PROVES:
 *   - A user_integration_connections row belonging to org B / org B's member is
 *     not returned to org A's member calling GET /mail/accounts; the response array
 *     is empty for org A even though the row exists in the database.
 *   - Org B's own member sees their account at 200 (the allowing control — confirms the
 *     row is live and accessible to its rightful owner).
 *   - A DB re-read after org A's call confirms org B's row is intact and unchanged
 *     (integrity check: the call did not silently mutate or destroy the neighbour's data).
 *
 * DOES NOT PROVE:
 *   - Attribution of the cross-tenant isolation to any single layer. The service
 *     predicate eq(userIntegrationConnections.orgId, orgId) in
 *     MailAccountsService.listAccounts provides one layer. If RLS is enabled on
 *     user_integration_connections with a tenant isolation policy, that layer alone
 *     hides the row and deleting the service predicate while RLS is active would leave
 *     this file green. The unit spec mail-accounts-tenant-isolation.spec.ts asserts
 *     the predicate is constructed correctly; this file proves the deployed system
 *     refuses. Neither file replaces the other.
 *   - Provider connectivity. GET /mail/accounts queries user_integration_connections
 *     directly through MailAccountsService.listAccounts and never calls a mail
 *     provider (Gmail, Outlook), so a valid Composio-connected account is not required
 *     for the assertions to be meaningful. Routes that proxy provider traffic
 *     (GET /mail/messages, GET /mail/threads/:threadId) are out of scope for this
 *     file because they require a connected provider account that the seed cannot create.
 */
describe("[seeded-e2e] Mail accounts — cross-tenant isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let neighbourAccountId: number | null = null;
  let homeToken = "";
  let neighbourToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("user")
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("user")
      .build();

    const [row] = await seeded.seedDb
      .insert(userIntegrationConnections)
      .values({
        orgId: neighbour.orgId,
        userId: neighbour.members.user.userId,
        membershipId: neighbour.members.user.membershipId,
        toolkit: "gmail",
        composioConnectedAccountId: `test-${randomUUID()}`,
        accountEmail: "neighbour@example.invalid",
        status: "active",
        isPrimary: false,
      })
      .returning({ id: userIntegrationConnections.id });

    neighbourAccountId = row?.id ?? null;

    homeToken = await signSeededToken(
      seeded,
      home.members.user.userId,
      home.orgId,
    );
    neighbourToken = await signSeededToken(
      seeded,
      neighbour.members.user.userId,
      neighbour.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (neighbourAccountId !== null)
      await seeded.seedDb
        .delete(userIntegrationConnections)
        .where(eq(userIntegrationConnections.id, neighbourAccountId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("fixture check — two members are in different organisations and org B's account row is seeded", () => {
    expect(home.orgId).not.toBe(neighbour.orgId);
    expect(neighbourAccountId).not.toBeNull();
    expect(neighbourAccountId).toBeGreaterThan(0);
  });

  it("ALLOW — org B's member reads GET /mail/accounts at 200 and the seeded row is present in the response", async () => {
    const response = await request(server as never)
      .get("/mail/accounts")
      .set("Authorization", `Bearer ${neighbourToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toMatchObject(
      expect.arrayContaining([expect.objectContaining({ id: neighbourAccountId })]),
    );
  });

  it("CROSS-TENANT — org A's member calls GET /mail/accounts and receives 200 with an array that excludes org B's account", async () => {
    const response = await request(server as never)
      .get("/mail/accounts")
      .set("Authorization", `Bearer ${homeToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).not.toMatchObject(
      expect.arrayContaining([expect.objectContaining({ id: neighbourAccountId })]),
    );
  });

  it("INTEGRITY — org B's account row still exists in the database and is unchanged after org A's read", async () => {
    const [row] = await seeded.seedDb
      .select({
        id: userIntegrationConnections.id,
        orgId: userIntegrationConnections.orgId,
        status: userIntegrationConnections.status,
      })
      .from(userIntegrationConnections)
      .where(eq(userIntegrationConnections.id, neighbourAccountId ?? 0));

    expect(row).toBeDefined();
    expect(row?.id).toBe(neighbourAccountId);
    expect(row?.orgId).toBe(neighbour.orgId);
    expect(row?.status).toBe("active");
  });
});
