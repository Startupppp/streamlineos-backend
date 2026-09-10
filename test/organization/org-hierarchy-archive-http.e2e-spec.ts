import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";

const NONEXISTENT_UNIT = "00000000-0000-0000-0000-000000000099";

describe("org-hierarchy archive HTTP protection", () => {
  let app: INestApplication;
  let ownerTokenOrgB: string;
  let memberTokenNoManage: string;

  beforeAll(async () => {
    app = await createE2eApp();

    ownerTokenOrgB = await signToken({
      sub: "user-http-probe",
      orgId: "org-http-probe-b",
      isOrgOwner: true,
    });

    memberTokenNoManage = await signToken({
      sub: "user-http-member",
      orgId: "org-http-probe-b",
      permissions: ["settings:view"],
    });
  });

  afterAll(async () => app.close());

  it("403 when in-tenant member lacks settings:organization:manage on PATCH /org-hierarchy/business-units/:id (archive)", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/org-hierarchy/business-units/${NONEXISTENT_UNIT}`)
      .set("Authorization", `Bearer ${memberTokenNoManage}`)
      .send({ status: "ARCHIVED" });

    expect(res.status).toBe(403);
  });

  it("404 (not 403) when org owner targets a unit that does not exist in their org on PATCH /org-hierarchy/business-units/:id (archive)", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/org-hierarchy/business-units/${NONEXISTENT_UNIT}`)
      .set("Authorization", `Bearer ${ownerTokenOrgB}`)
      .send({ status: "ARCHIVED" });

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });
});
