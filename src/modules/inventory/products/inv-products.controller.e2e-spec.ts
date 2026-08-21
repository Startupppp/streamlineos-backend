import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "../../../../test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";

describe("/inventory/products (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createE2eApp();
    token = await signToken({
      sub: "owner_1",
      orgId: "org_inv_01",
      isOrgOwner: true,
      enabledModules: ["inventory"],
    });
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
