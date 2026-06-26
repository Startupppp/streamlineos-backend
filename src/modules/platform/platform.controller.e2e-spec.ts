import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("Platform auth (e2e)", () => {
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
    expect(res.body).toEqual({ ok: false });
  });
});
