import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { NotFoundException } from "@nestjs/common";
import { KbPublicPagesController } from "./kb-public-pages.controller";
import { KbPagesService } from "./kb-pages.service";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";

describe("KbPublicPagesController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const FIXED_UPDATED_AT = new Date("2025-06-01T12:00:00Z");
    const FIXED_REVISION = 7;

    const mockPagesService = {
      getPublicPage: async (token: string) => {
        if (token === "validtoken123abc") {
          return {
            title: "Test Page",
            icon: null,
            coverImage: null,
            content: null,
            updatedAt: FIXED_UPDATED_AT,
            publicTokenRevision: FIXED_REVISION,
          };
        }
        throw new NotFoundException("Page not found");
      },
    };

    const mockRateLimit = { check: jest.fn().mockResolvedValue({ allowed: true }) };

    const ref = await Test.createTestingModule({
      controllers: [KbPublicPagesController],
      providers: [
        { provide: KbPagesService, useValue: mockPagesService },
        { provide: RateLimitService, useValue: mockRateLimit },
      ],
    }).compile();

    app = ref.createNestApplication();
    await app.init();
  });

  afterAll(async () => app?.close());

  it("GET /public/wiki/validtoken123abc returns 200 with page data", async () => {
    const res = await request(app.getHttpServer()).get("/public/wiki/validtoken123abc");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "Test Page" });
  });

  it("GET /public/wiki/unknowntoken returns 404", async () => {
    const res = await request(app.getHttpServer()).get("/public/wiki/unknowntoken");
    expect(res.status).toBe(404);
  });

  it("GET /public/wiki/<65 chars> returns 404 for invalid token", async () => {
    const longToken = "a".repeat(65);
    const res = await request(app.getHttpServer()).get(`/public/wiki/${longToken}`);
    expect(res.status).toBe(404);
  });

  it("GET /public/wiki/<special chars> returns 404 for bad chars", async () => {
    const res = await request(app.getHttpServer()).get("/public/wiki/bad$token!");
    expect(res.status).toBe(404);
  });

  it("GET /public/wiki/validtoken123abc sets ETag header keyed on updatedAt and revision", async () => {
    const res = await request(app.getHttpServer()).get("/public/wiki/validtoken123abc");
    expect(res.status).toBe(200);
    const expectedETag = `"${new Date("2025-06-01T12:00:00Z").getTime()}-7"`;
    expect(res.headers.etag).toBe(expectedETag);
  });

  it("GET /public/wiki/validtoken123abc sets Cache-Control public header", async () => {
    const res = await request(app.getHttpServer()).get("/public/wiki/validtoken123abc");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/public/);
  });

  it("GET /public/wiki/validtoken123abc does not include publicTokenRevision in the response body", async () => {
    const res = await request(app.getHttpServer()).get("/public/wiki/validtoken123abc");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("publicTokenRevision");
  });

  it("GET /public/wiki/validtoken123abc response body matches the public page shape without internal fields", async () => {
    const res = await request(app.getHttpServer()).get("/public/wiki/validtoken123abc");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "Test Page", icon: null, coverImage: null, content: null });
    expect(res.body).not.toHaveProperty("publicToken");
    expect(res.body).not.toHaveProperty("publicTokenHash");
  });
});
