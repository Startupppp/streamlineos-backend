import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { FormsService } from "./forms.service";
import { SubmissionsService } from "./submissions.service";

const formsSvc = {
  listForms: jest.fn(),
  getForm: jest.fn(),
  createForm: jest.fn(),
  updateForm: jest.fn(),
  deleteForm: jest.fn(),
};

const submissionsSvc = {
  listSubmissions: jest.fn(),
  createSubmission: jest.fn(),
  updateSubmission: jest.fn(),
};

describe("ProjectsForms auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: FormsService, useValue: formsSvc },
        { provide: SubmissionsService, useValue: submissionsSvc },
      ],
    });
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  type Method = "get" | "post" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/build/1/forms"],
    ["get", "/build/1/forms/2"],
    ["post", "/build/1/forms"],
    ["patch", "/build/1/forms/2"],
    ["delete", "/build/1/forms/2"],
    ["get", "/build/1/forms/2/submissions"],
    ["post", "/build/1/forms/2/submissions"],
    ["patch", "/build/1/forms/2/submissions/3"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on POST /projects/1/forms without projects:forms:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/forms")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "My Form", fields: [], actions: [] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/forms without projects:forms:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/forms")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/forms/2/submissions without projects:forms:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/forms/2/submissions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/forms/2/submissions without projects:forms:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/forms/2/submissions")
      .set("Authorization", `Bearer ${token}`)
      .send({ values: {} });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/forms with build:forms:view — stub returns list without a DB connection", async () => {
    formsSvc.listForms.mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
    const token = await signToken({ permissions: ["build:forms:view"], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/forms")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(formsSvc.listForms).toHaveBeenCalled();
  });

  it("400 on POST /build/1/forms with a direct cycle in conditional logic (A depends on B, B depends on A)", async () => {
    const token = await signToken({ permissions: ["build:forms:manage"], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/forms")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Cyclic Form",
        fields: [
          {
            key: "a",
            label: "Field A",
            type: "text",
            required: false,
            conditionalLogic: { action: "show", match: "all", conditions: [{ fieldKey: "b", operator: "eq", value: "yes" }] },
          },
          {
            key: "b",
            label: "Field B",
            type: "text",
            required: false,
            conditionalLogic: { action: "show", match: "all", conditions: [{ fieldKey: "a", operator: "eq", value: "yes" }] },
          },
        ],
        actions: [],
      });
    expect(res.status).toBe(400);
  });

  it("400 on POST /build/1/forms when a numeric operator is applied to a non-numeric field", async () => {
    const token = await signToken({ permissions: ["build:forms:manage"], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/forms")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Type Mismatch Form",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          {
            key: "extra",
            label: "Extra",
            type: "text",
            required: false,
            conditionalLogic: { action: "show", match: "all", conditions: [{ fieldKey: "name", operator: "gt", value: 5 }] },
          },
        ],
        actions: [],
      });
    expect(res.status).toBe(400);
  });
});
