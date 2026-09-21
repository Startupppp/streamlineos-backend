import { type INestApplication, ConflictException, NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AiConfirmationService } from "../confirmation/ai-confirmation.service";
import { OrgFeaturesService } from "./services/org-features.service";

const FULL_FLAGS = {
  aiChat: true,
  aiLeadScoring: true,
  aiEmailDraft: true,
  aiSmartNotifications: true,
  aiWeeklyRecap: true,
  supportAi: true,
};

describe("POST /chat/proposals/:proposalId/decline (e2e)", () => {
  let app: INestApplication;

  const mockDecline = jest.fn();
  const mockGetFlags = jest.fn();

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        {
          provide: AiConfirmationService,
          useValue: {
            confirm: jest.fn(),
            markExecuted: jest.fn(),
            propose: jest.fn(),
            decline: mockDecline,
          },
        },
        {
          provide: OrgFeaturesService,
          useValue: { getFlags: mockGetFlags },
        },
      ],
    });
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    jest.resetAllMocks();
    mockGetFlags.mockResolvedValue(FULL_FLAGS);
  });

  it("returns 401 and UNAUTHORIZED when no bearer token is presented", async () => {
    const res = await request(app.getHttpServer())
      .post("/chat/proposals/1/decline")
      .send();
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("returns 403 and FORBIDDEN when the caller lacks ai:chat:use", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/proposals/1/decline")
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("returns 403 and FORBIDDEN when the org aiChat feature flag is disabled, even with ai:chat:use", async () => {
    mockGetFlags.mockResolvedValue({ ...FULL_FLAGS, aiChat: false });
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/proposals/1/decline")
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns 400 and VALIDATION_FAILED when the proposalId route param is not a positive integer", async () => {
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/proposals/not-a-number/decline")
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("returns 404 and NOT_FOUND when the decline service throws NotFoundException, so a cross-tenant proposalId reveals nothing", async () => {
    mockDecline.mockRejectedValue(new NotFoundException("Proposal not found"));
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/proposals/999/decline")
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns 409 and CONFLICT when the decline service throws ConflictException, because the proposal is already confirmed or executed", async () => {
    mockDecline.mockRejectedValue(new ConflictException("Proposal cannot be declined"));
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/proposals/1/decline")
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "CONFLICT" });
  });

  it("returns 200 with declined:true and calls decline with the proposalId from the route and actor identity from the token, never from the request body", async () => {
    mockDecline.mockResolvedValue(undefined);
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/chat/proposals/42/decline")
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ declined: true });
    expect(mockDecline).toHaveBeenCalledWith(42, "org_1", expect.any(String));
  });

  it("does not pass orgId or userId from a request body field — the identity must come from the JWT only", async () => {
    mockDecline.mockResolvedValue(undefined);
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    await request(app.getHttpServer())
      .post("/chat/proposals/5/decline")
      .set("Authorization", `Bearer ${token}`)
      .send({ orgId: "org_attacker", userId: "user_attacker" });
    expect(mockDecline).toHaveBeenCalledWith(5, "org_1", expect.not.stringContaining("attacker"));
  });

  it("is idempotent from the controller perspective — a second decline on the same proposal returns 200 when the service is idempotent", async () => {
    mockDecline.mockResolvedValue(undefined);
    const token = await signToken({ permissions: ["ai:chat:use"], enabledModules: ALL_MODULES });
    const first = await request(app.getHttpServer())
      .post("/chat/proposals/7/decline")
      .set("Authorization", `Bearer ${token}`)
      .send();
    const second = await request(app.getHttpServer())
      .post("/chat/proposals/7/decline")
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockDecline).toHaveBeenCalledTimes(2);
  });
});
