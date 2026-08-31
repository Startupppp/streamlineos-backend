import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Platform auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  it("does NOT require auth on GET /platform/visit (public endpoint)", async () => {
    const res = await request(app.getHttpServer()).get("/platform/visit");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(405);
  });

  it("does NOT require auth on POST /platform/visit (public endpoint)", async () => {
    const res = await request(app.getHttpServer())
      .post("/platform/visit")
      .send({ path: "x" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("400 on POST /platform/visit with an invalid body", async () => {
    const res = await request(app.getHttpServer())
      .post("/platform/visit")
      .send({ path: "x" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
