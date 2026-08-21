import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Careers auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
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
