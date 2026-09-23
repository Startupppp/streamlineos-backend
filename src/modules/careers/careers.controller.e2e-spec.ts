import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

/**
 * The legacy careers doors are gone, and these two cases are what stops them
 * coming back.
 *
 * `GET /careers` returned every organisation's open jobs to an unauthenticated
 * caller, and `POST /careers/apply` was a second apply that inferred the tenant
 * from a bare `jobPostingId`. Both were live at `e8f8ae3c2`. A 404 here is the
 * assertion; a 401/403 would mean the route still exists behind a guard.
 */
describe("Careers legacy doors (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  it("GET /careers is gone — it listed every tenant's open jobs", async () => {
    const res = await request(app.getHttpServer()).get("/careers");
    expect(res.status).toBe(404);
  });

  it("POST /careers/apply is gone — the org-scoped apply is the only door", async () => {
    const res = await request(app.getHttpServer())
      .post("/careers/apply")
      .send({ jobPostingId: 1, name: "Jane Doe", email: "jane@example.com", consent: true });
    expect(res.status).toBe(404);
  });

  it("does NOT require auth on the org-scoped apply being missing-org (public endpoint)", async () => {
    const res = await request(app.getHttpServer())
      .post("/public/careers/no-such-org/jobs/1/apply")
      .send({ name: "Jane Doe", email: "jane@example.com", consent: true });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
