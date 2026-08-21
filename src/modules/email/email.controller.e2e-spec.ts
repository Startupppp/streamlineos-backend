import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Email routes auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  const routes: ReadonlyArray<[string]> = [
    ["/notifications/dispatch"],
    ["/settings/email-templates/test"],
  ];

  it.each(routes)("401 on POST %s without a token", async (path) => {
    const res = await request(app.getHttpServer()).post(path).send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});
