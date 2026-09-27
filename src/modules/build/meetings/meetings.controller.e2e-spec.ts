import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { MeetingsService } from "./meetings.service";
import { ActionItemsService } from "./action-items.service";

const meetingsSvc = {
  listMeetings: jest.fn(),
  getMeeting: jest.fn(),
  createMeeting: jest.fn(),
  updateMeeting: jest.fn(),
  deleteMeeting: jest.fn(),
  addAttendee: jest.fn(),
  removeAttendee: jest.fn(),
  upsertStandup: jest.fn(),
};

const actionItemsSvc = {
  createActionItem: jest.fn(),
  updateActionItem: jest.fn(),
  deleteActionItem: jest.fn(),
  convertToTask: jest.fn(),
};

describe("ProjectsMeetings / ActionItems auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: MeetingsService, useValue: meetingsSvc },
        { provide: ActionItemsService, useValue: actionItemsSvc },
      ],
    });
  });

  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  type Method = "get" | "post" | "patch" | "delete" | "put";

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
      case "put":
        return agent.put(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/build/1/meetings"],
    ["get", "/build/1/meetings/2"],
    ["post", "/build/1/meetings"],
    ["patch", "/build/1/meetings/2"],
    ["delete", "/build/1/meetings/2"],
    ["post", "/build/1/meetings/2/attendees"],
    ["delete", "/build/1/meetings/2/attendees/user-x"],
    ["put", "/build/1/meetings/2/standup"],
    ["post", "/build/1/meetings/2/action-items"],
    ["patch", "/build/1/meetings/2/action-items/3"],
    ["delete", "/build/1/meetings/2/action-items/3"],
    ["post", "/build/1/meetings/2/action-items/3/convert-to-task"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /projects/1/meetings without projects:meetings:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/meetings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/meetings without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/meetings")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Sprint Review" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /projects/1/meetings/2 without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .delete("/build/1/meetings/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/meetings/2/attendees without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/meetings/2/attendees")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "user-3" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PUT /projects/1/meetings/2/standup without projects:meetings:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .put("/build/1/meetings/2/standup")
      .set("Authorization", `Bearer ${token}`)
      .send({ today: "finishing tests" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/meetings/2/action-items without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/meetings/2/action-items")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Write docs" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST convert-to-task without projects:meetings:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/meetings/2/action-items/3/convert-to-task")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/meetings with build:meetings:view — stub returns list without a DB connection", async () => {
    meetingsSvc.listMeetings.mockResolvedValue({ items: [], nextCursor: null });
    const token = await signToken({
      permissions: ["build:meetings:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/meetings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(meetingsSvc.listMeetings).toHaveBeenCalled();
  });

  it("201 on POST /build/1/meetings with build:meetings:manage — stub returns item without a DB connection", async () => {
    meetingsSvc.createMeeting.mockResolvedValue({ id: 2, title: "Sprint Review", projectId: 1 });
    const token = await signToken({
      permissions: ["build:meetings:manage"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/meetings")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Sprint Review" });
    expect(res.status).toBe(201);
    expect(meetingsSvc.createMeeting).toHaveBeenCalled();
  });
});
