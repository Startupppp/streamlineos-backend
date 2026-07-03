import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "src/app.module";

describe("KbPageRecordLinks (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /kb/pages/1/record-links requires auth", async () => {
    const res = await request(app.getHttpServer()).get("/kb/pages/1/record-links");
    expect(res.status).toBe(401);
  });

  it("POST /kb/pages/1/record-links requires auth", async () => {
    const res = await request(app.getHttpServer()).post("/kb/pages/1/record-links").send({});
    expect(res.status).toBe(401);
  });

  it("DELETE /kb/record-links/1 requires auth", async () => {
    const res = await request(app.getHttpServer()).delete("/kb/record-links/1");
    expect(res.status).toBe(401);
  });

  it("GET /kb/record-links/by-record requires auth", async () => {
    const res = await request(app.getHttpServer()).get("/kb/record-links/by-record");
    expect(res.status).toBe(401);
  });
});
