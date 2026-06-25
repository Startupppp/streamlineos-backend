import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Contacts auth/RBAC (e2e)", () => {
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

  it("401 on GET /contacts without a token", async () => {
    const res = await request(app.getHttpServer()).get("/contacts");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /contacts without crm:contacts read", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer()).get("/contacts").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Forbidden", code: "RBAC_DENIED", verb: "read", subject: "crm:contacts" });
  });

  it("403 on POST /contacts without crm:contacts create", async () => {
    const token = await signToken({ permissions: ["crm:contacts:read"], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/contacts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Jane" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "create", subject: "crm:contacts" });
  });

  it("403 on DELETE /contacts/1 without crm:contacts delete", async () => {
    const token = await signToken({ permissions: ["crm:contacts:read"], enabledModules: [] });
    const res = await request(app.getHttpServer()).delete("/contacts/1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "delete", subject: "crm:contacts" });
  });

  it("403 on GET /contacts/search without crm:contacts read", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/contacts/search?q=jane")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "read", subject: "crm:contacts" });
  });

  it("403 on GET /contacts/1/vcard without crm:contacts read", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer()).get("/contacts/1/vcard").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "read", subject: "crm:contacts" });
  });
});
