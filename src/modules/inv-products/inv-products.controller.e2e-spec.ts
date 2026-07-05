import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("/inventory/products (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    token = await signToken({ orgId: "org_inv_01", isOrgOwner: true, enabledModules: ["inventory"] });
  });

  afterAll(async () => app.close());

  it("401 on GET /inventory/products without token", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/products");
    expect(res.status).toBe(401);
  });

  it("200 on GET /inventory/products", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/products")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("404 on POST /inventory/products/99999999/archive for non-existent product", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/products/99999999/archive")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("404 on POST /inventory/products/99999999/restore for non-existent product", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/products/99999999/restore")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("400 on create product with invalid tracking method", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Test", sku: "TEST-001", trackingMethod: "INVALID" });
    expect(res.status).toBe(400);
  });

  it("list products returns paginated shape", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/products?page=1&limit=10")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("page");
    expect(body).toHaveProperty("totalPages");
  });

  it("list products supports productType filter", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/products?productType=STOCKABLE")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("400 on create product with invalid productType", async () => {
    const res = await request(app.getHttpServer())
      .post("/inventory/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Test", sku: "TEST-999", productType: "INVALID_TYPE" });
    expect(res.status).toBe(400);
  });

  it("200 on GET /inventory/products/uom", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/products/uom")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
