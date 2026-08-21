import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Leads ingest (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  it("401 without X-API-Key", async () => {
    const res = await request(app.getHttpServer()).post("/leads/ingest").send({ name: "x" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Missing X-API-Key header" });
  });
});
