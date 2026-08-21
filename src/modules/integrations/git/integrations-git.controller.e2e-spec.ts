import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("IntegrationsGit auth (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => app.close());

  it("does NOT require auth on POST /integrations/git/webhook", async () => {
    const res = await request(app.getHttpServer())
      .post("/integrations/git/webhook?connectionId=not-a-number")
      .send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("acknowledges an unverifiable webhook without touching the DB", async () => {
    const res = await request(app.getHttpServer())
      .post("/integrations/git/webhook?connectionId=not-a-number")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
