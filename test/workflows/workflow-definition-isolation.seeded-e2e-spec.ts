import { eq } from "drizzle-orm";
import request from "supertest";
import { workflows } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * First seeded-database Workflows spec in this repository.
 *
 * The existing mocked Workflows suites (workflows-*-tenant-isolation.spec.ts)
 * assert that service-level predicates are built correctly but cannot confirm
 * that Postgres enforces them. This file asks the remaining question: two seeded
 * organisations, real guards, the real RBAC resolver and a real Postgres.
 *
 * What this file proves:
 *   fixture      two orgs and two workflow definitions are properly isolated
 *   ALLOW        an org A member holding workflows:workflows:view can read their
 *                own workflow definition (200)
 *   DENY (RBAC)  a member holding only workflows:workflows:view cannot mutate a
 *                home workflow via PATCH (403 before the handler runs)
 *   integrity    after the 403, the workflow row is re-read from the database
 *                and its name is unchanged — proving the guard bit, not just the
 *                response code
 *   cross-tenant an org A member requesting org B's workflow id via GET answers
 *                404, not 403 — a 403 would confirm the record exists (§4)
 *   integrity    after the cross-tenant GET probe, org B's workflow row is re-read
 *                from the database and is unchanged
 *
 * What this file does NOT prove, measured rather than assumed:
 *   If the workflows table carries an RLS policy using app.current_org_id(), a
 *   cross-tenant request returns 404 even with the service orgId predicate
 *   removed — RLS blocks visibility before the service can answer. Attribution
 *   of the 404 to the service predicate belongs to the existing mocked unit tests
 *   (workflows-crud-tenant-isolation.spec.ts) that compile the predicate. The
 *   RBAC/DENY leg is what this file can attribute on its own: changing the PATCH
 *   handler's @RequirePermission from "workflows:workflows:update" to
 *   "workflows:workflows:view" turns the DENY test red here and nowhere else.
 *
 * Route surface exercised:
 *   GET   /workflows/:workflowId   (workflows:workflows:view)
 *   PATCH /workflows/:workflowId   (workflows:workflows:update)
 *
 * Neither route carries @Idempotent, so no Idempotency-Key header is required.
 */

describe("[seeded-e2e] Workflow definitions — RBAC deny and cross-tenant isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let homeWorkflowId = "";
  let neighbourWorkflowId = "";
  let managerToken = "";
  let viewerToken = "";
  let server: unknown;

  const HOME_WORKFLOW_NAME = "home-workflow-seeded";
  const NEIGHBOUR_WORKFLOW_NAME = "neighbour-workflow-seeded";

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("workflows")
      .addMember("manager", {
        permissionKeys: [
          "workflows:workflows:view",
          "workflows:workflows:update",
        ],
      })
      .addMember("viewer", {
        permissionKeys: ["workflows:workflows:view"],
      })
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("workflows")
      .addMember("manager", {
        permissionKeys: [
          "workflows:workflows:view",
          "workflows:workflows:update",
        ],
      })
      .build();

    const [homeWf] = await seeded.seedDb
      .insert(workflows)
      .values({
        orgId: home.orgId,
        name: HOME_WORKFLOW_NAME,
        status: "draft",
      })
      .returning({ id: workflows.id });
    homeWorkflowId = homeWf?.id ?? "";

    const [neighbourWf] = await seeded.seedDb
      .insert(workflows)
      .values({
        orgId: neighbour.orgId,
        name: NEIGHBOUR_WORKFLOW_NAME,
        status: "draft",
      })
      .returning({ id: workflows.id });
    neighbourWorkflowId = neighbourWf?.id ?? "";

    managerToken = await signSeededToken(
      seeded,
      home.members.manager.userId,
      home.orgId,
    );
    viewerToken = await signSeededToken(
      seeded,
      home.members.viewer.userId,
      home.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (homeWorkflowId)
      await seeded.seedDb
        .delete(workflows)
        .where(eq(workflows.id, homeWorkflowId));
    if (neighbourWorkflowId)
      await seeded.seedDb
        .delete(workflows)
        .where(eq(workflows.id, neighbourWorkflowId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  async function nameOf(workflowId: string): Promise<string | undefined> {
    const [row] = await seeded.seedDb
      .select({ name: workflows.name })
      .from(workflows)
      .where(eq(workflows.id, workflowId));
    return row?.name;
  }

  it("fixture check — two orgs and two workflow definitions are distinct", () => {
    expect(home.orgId).not.toBe(neighbour.orgId);
    expect(homeWorkflowId).not.toBe("");
    expect(neighbourWorkflowId).not.toBe("");
    expect(homeWorkflowId).not.toBe(neighbourWorkflowId);
  });

  it("ALLOW — the home manager reads their own workflow definition", async () => {
    const response = await request(server as never)
      .get(`/workflows/${homeWorkflowId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
  });

  it("DENY — a viewer holding only workflows:workflows:view is refused PATCH at 403", async () => {
    const before = await nameOf(homeWorkflowId);

    const response = await request(server as never)
      .patch(`/workflows/${homeWorkflowId}`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "attempted-rename" });

    expect(response.status).toBe(403);
    expect(await nameOf(homeWorkflowId)).toBe(before);
  });

  it("CROSS-TENANT read — org A member requesting org B's workflow id answers 404, not 403 or 200", async () => {
    const response = await request(server as never)
      .get(`/workflows/${neighbourWorkflowId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(404);
  });

  it("CROSS-TENANT write — org A member PATCHing org B's workflow id answers 404 and leaves the row unchanged", async () => {
    expect(await nameOf(neighbourWorkflowId)).toBe(NEIGHBOUR_WORKFLOW_NAME);

    const response = await request(server as never)
      .patch(`/workflows/${neighbourWorkflowId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ name: "cross-tenant-rename-attempt" });

    expect(response.status).toBe(404);
    expect(await nameOf(neighbourWorkflowId)).toBe(NEIGHBOUR_WORKFLOW_NAME);
  });

  it("persists an authorized update and returns it on the next request", async () => {
    const name = "authorized-home-workflow-rename";
    const updated = await request(seeded.app.getHttpServer())
      .patch(`/workflows/${homeWorkflowId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ name });
    expect(updated.status).toBe(200);
    expect(await nameOf(homeWorkflowId)).toBe(name);

    const read = await request(seeded.app.getHttpServer())
      .get(`/workflows/${homeWorkflowId}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: homeWorkflowId, name });
    expect(await nameOf(neighbourWorkflowId)).toBe(NEIGHBOUR_WORKFLOW_NAME);
  });

  it("rejects unauthenticated mutations without changing the stored definition", async () => {
    const before = await nameOf(homeWorkflowId);
    const response = await request(seeded.app.getHttpServer())
      .patch(`/workflows/${homeWorkflowId}`)
      .send({ name: "anonymous-rename" });
    expect(response.status).toBe(401);
    expect(await nameOf(homeWorkflowId)).toBe(before);
  });
});
