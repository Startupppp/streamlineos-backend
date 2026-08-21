import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("Blog endpoints (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
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
