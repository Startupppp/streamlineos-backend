import { eq } from "drizzle-orm";
import request from "supertest";
import { timesheets } from "src/db/schema";
import { createBuildWorkflowFixture, type BuildWorkflowFixture } from "./build-workflow-fixtures";

describe("[seeded-e2e] Build timesheet write response contracts", () => {
  let fixture: BuildWorkflowFixture;
  beforeAll(async () => {
    fixture = await createBuildWorkflowFixture();
    await fixture.home.grantPermissions("manager", ["build:timesheets:view", "build:timesheets:create", "build:timesheets:manage"]);
  }, 180_000);
  afterAll(async () => {
    if (!fixture) return;
    await fixture.seeded.seedDb.delete(timesheets).where(eq(timesheets.orgId, fixture.home.orgId));
    await fixture.close();
  }, 120_000);

  function api() { return request(fixture.seeded.app.getHttpServer()); }
  function authorization() { return { Authorization: `Bearer ${fixture.managerToken}` }; }
  async function seedEntry(membershipId: number) {
    const [entry] = await fixture.seeded.seedDb.insert(timesheets).values({
      orgId: fixture.home.orgId, projectId: fixture.projectId, ticketId: fixture.ticketIds[0],
      userMembershipId: membershipId, date: "2026-09-09", hours: "1", status: "PENDING",
    }).returning({ id: timesheets.id });
    return entry.id;
  }

  it("returns the created row without requiring an unfetched ticket relation", async () => {
    const response = await api().post(`/build/${fixture.projectId}/tickets/${fixture.ticketIds[0]}/time-entries`)
      .set(authorization()).send({ date: "2026-09-09", hours: 2, description: "Contract verification" });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ hours: "2.00", status: "PENDING", ticketId: fixture.ticketIds[0] });
    expect(response.body).not.toHaveProperty("ticket");
  });

  it("returns the updated row without requiring an unfetched ticket relation", async () => {
    const id = await seedEntry(fixture.home.members.manager.membershipId);
    const response = await api().patch(`/build/time-entries/${id}`).set(authorization()).send({ hours: 3 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id, hours: "3.00", status: "PENDING" });
    expect(response.body).not.toHaveProperty("ticket");
  });

  it("returns success after an authorized rejection", async () => {
    const id = await seedEntry(fixture.home.members.limited.membershipId);
    const response = await api().patch(`/build/time-entries/${id}/reject`).set(authorization())
      .set("Idempotency-Key", crypto.randomUUID()).send({ reason: "Needs correction" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
  });
});
