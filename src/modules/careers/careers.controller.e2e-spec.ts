import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("Careers auth (e2e)", () => {
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

  it("does NOT require auth on GET /careers (public endpoint)", async () => {
    const res = await request(app.getHttpServer()).get("/careers");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT require auth on POST /careers/apply (public endpoint)", async () => {
    const res = await request(app.getHttpServer())
      .post("/careers/apply")
      .send({ jobPostingId: 1, name: "Jane Doe", email: "jane@example.com" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
