import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Blog endpoints (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => app.close());

  it.each(["/blog/posts", "/blog/categories", "/blog/search?q=onboarding", "/blog/sitemap/posts"])(
    "GET %s does not require auth (public endpoint)",
    async (path) => {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );

  it("GET /blog/by-slug/:slug does not require auth (public endpoint)", async () => {
    const res = await request(app.getHttpServer()).get("/blog/by-slug/nonexistent");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("POST /blog/internal/invalidate refuses an unsigned delivery", async () => {
    const res = await request(app.getHttpServer())
      .post("/blog/internal/invalidate")
      .send({ eventId: "11111111-1111-4111-8111-111111111111", postId: "22222222-2222-4222-8222-222222222222", generation: 1, reason: "publish" });
    expect([401, 503]).toContain(res.status);
  });

  it("the old admin write API is gone", async () => {
    const res = await request(app.getHttpServer()).post("/blog/admin/posts").send({});
    expect(res.status).toBe(404);
  });
});
