import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "../../../../test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";

/**
 * G1 — the inventory audit trail's first read surface.
 *
 * `inv_audit_events` has been written since the module shipped and read only by
 * D7's export. The list is cursor-only: `page` is not accepted, because a trail
 * that is appended to while it is read has no stable offsets to hand out.
 *
 *   pnpm test:e2e --testPathPattern="inv-audit-events"
 */
describe("/inventory/audit-events (e2e)", () => {
  let app: INestApplication;
  let owner: string;
  let outsider: string;

  beforeAll(async () => {
    app = await createE2eApp();
    owner = await signToken({
      sub: "owner_1",
      orgId: "org_inv_01",
      isOrgOwner: true,
      enabledModules: ["inventory"],
    });
    // Authenticated, inventory enabled, holding nothing.
    outsider = await signToken({
      sub: "member_1",
      orgId: "org_inv_01",
      enabledModules: ["inventory"],
    });
  });

  afterAll(async () => app.close());

  it("401 without a token", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/audit-events");
    expect(res.status).toBe(401);
  });

  it("403 for a caller inside the tenant who does not hold inventory:audit:read", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/audit-events")
      .set("Authorization", `Bearer ${outsider}`);
    expect(res.status).toBe(403);
  });

  it("200 and a cursor envelope for a holder", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/audit-events")
      .set("Authorization", `Bearer ${owner}`);
    expect(res.status).toBe(200);

    const body = res.body.data ?? res.body;
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.hasMore).toBe("boolean");
    expect(body).toHaveProperty("nextCursor");
    // The trail says who changed what, not what the record used to hold: D7
    // hashes `before`/`after`/`metadata` rather than emitting them, and a read
    // surface must not move that line.
    for (const row of body.items) {
      expect(row).not.toHaveProperty("before");
      expect(row).not.toHaveProperty("after");
      expect(row).not.toHaveProperty("metadata");
    }
  });

  it("400 on an offset, which this list does not offer", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/audit-events?page=2")
      .set("Authorization", `Bearer ${owner}`);
    expect(res.status).toBe(400);
  });

  it("400 above the 100-per-page cap", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/audit-events?limit=101")
      .set("Authorization", `Bearer ${owner}`);
    expect(res.status).toBe(400);
  });

  it("200 and the first page for a cursor that cannot be trusted", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/audit-events?cursor=not-a-cursor")
      .set("Authorization", `Bearer ${owner}`);
    expect(res.status).toBe(200);
  });
});
