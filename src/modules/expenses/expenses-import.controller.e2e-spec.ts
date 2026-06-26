import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Expenses import auth/RBAC (e2e)", () => {
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

  it("401 on POST /hr/expenses/import without a token", async () => {
    const res = await request(app.getHttpServer()).post("/hr/expenses/import");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on POST /hr/expenses/import without approve hr:expenses", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/hr/expenses/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ fileName: "expenses.csv", content: "category,amount\nTravel,10" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only HR and CEO can import expenses" });
  });
});
