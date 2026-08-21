import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Blog endpoints (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => app.close());

  it("GET /blog/feed does not require auth (public endpoint)", async () => {
    const res = await request(app.getHttpServer()).get("/blog/feed");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("GET /blog/categories does not require auth (public endpoint)", async () => {
    const res = await request(app.getHttpServer()).get("/blog/categories");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("GET /blog/by-slug/:slug does not require auth (public endpoint)", async () => {
    const res = await request(app.getHttpServer()).get("/blog/by-slug/nonexistent");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
