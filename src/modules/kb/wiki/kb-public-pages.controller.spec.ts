import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { HttpException, NotFoundException } from "@nestjs/common";
import { KbPublicPagesController, KB_PUBLIC_MEDIA_URL_TTL_SECONDS } from "./kb-public-pages.controller";
import { KbPagePublicService } from "./kb-page-public.service";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { StorageService } from "../../storage/storage.service";

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
        { provide: KbPagePublicService, useValue: mockPagesService },
        { provide: RateLimitService, useValue: mockRateLimit },
        { provide: StorageService, useValue: { getFileUrl: jest.fn() } },
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

describe("KbPublicPagesController.getPublicMedia", () => {
  const SIGNED_URL = "https://bucket.example.com/org1/fileA.png?X-Amz-Expires=300&X-Amz-Signature=abc";
  const VALID_TOKEN = "pagetokenA";
  const FILE_A_KEY = "org1/fileA.png";
  const ORG_ID = "org-1";

  let mockValidateAttachment: jest.Mock;
  let mockRateLimitCheck: jest.Mock;
  let mockGetFileUrl: jest.Mock;
  let controller: KbPublicPagesController;

  beforeEach(() => {
    mockValidateAttachment = jest.fn(async () => ({ fileKey: FILE_A_KEY, orgId: ORG_ID }));
    mockRateLimitCheck = jest.fn(async () => ({ allowed: true }));
    mockGetFileUrl = jest.fn(async () => SIGNED_URL);
    controller = new KbPublicPagesController(
      { validatePublicAttachment: mockValidateAttachment } as never,
      { check: mockRateLimitCheck } as never,
      { getFileUrl: mockGetFileUrl } as never,
    );
  });

  const fakeReq = () => ({ ip: "1.2.3.4", headers: {} as Record<string, string> });

  it("redirects to a signed, expiring storage URL rather than a permanent public object URL, so revoking the share actually revokes its attachments instead of leaving every URL a client already holds valid forever", async () => {
    const redirect = jest.fn();

    await controller.getPublicMedia(VALID_TOKEN, FILE_A_KEY, fakeReq(), { redirect } as never);

    expect(redirect).toHaveBeenCalledWith(302, SIGNED_URL);
    expect(mockGetFileUrl).toHaveBeenCalledTimes(1);
  });

  it("signs the URL with a bounded lifetime, because an unbounded one reintroduces the permanent-URL defect under a different name", async () => {
    await controller.getPublicMedia(VALID_TOKEN, FILE_A_KEY, fakeReq(), { redirect: jest.fn() } as never);

    const [, , expiresIn] = mockGetFileUrl.mock.calls[0] as unknown[];
    expect(typeof expiresIn).toBe("number");
    expect(expiresIn as number).toBeGreaterThan(0);
    expect(expiresIn as number).toBeLessThanOrEqual(KB_PUBLIC_MEDIA_URL_TTL_SECONDS);
  });

  it("signs against the tenant that owns the page rather than any org derived from the client-supplied key, so a key naming another tenant cannot be signed under that tenant's placement", async () => {
    await controller.getPublicMedia(VALID_TOKEN, "org-other/file.png", fakeReq(), { redirect: jest.fn() } as never);

    const [orgId, fileKey] = mockGetFileUrl.mock.calls[0] as unknown[];
    expect(orgId).toBe(ORG_ID);
    expect(fileKey).toBe(FILE_A_KEY);
  });

  it("marks the signing call preauthorized, which is what lets the share token stand in for a session while still leaving the storage quarantine check in force for an infected object", async () => {
    await controller.getPublicMedia(VALID_TOKEN, FILE_A_KEY, fakeReq(), { redirect: jest.fn() } as never);

    const options = (mockGetFileUrl.mock.calls[0] as unknown[])[4] as { preauthorized?: boolean };
    expect(options.preauthorized).toBe(true);
  });

  it("throws NotFoundException without signing anything when the service rejects the key — positive control is the redirect test above", async () => {
    mockValidateAttachment.mockRejectedValue(new NotFoundException("Attachment not found"));
    const redirect = jest.fn();

    await expect(
      controller.getPublicMedia(VALID_TOKEN, "other/file.png", fakeReq(), { redirect } as never),
    ).rejects.toThrow(NotFoundException);
    expect(redirect).not.toHaveBeenCalled();
    expect(mockGetFileUrl).not.toHaveBeenCalled();
  });

  it("throws NotFoundException without calling the service when the token fails the alphanumeric-hyphen format check", async () => {
    const redirect = jest.fn();
    await expect(
      controller.getPublicMedia("bad$token!", FILE_A_KEY, fakeReq(), { redirect } as never),
    ).rejects.toThrow(NotFoundException);
    expect(mockValidateAttachment).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("throws NotFoundException without calling the service when the token exceeds 64 characters", async () => {
    const redirect = jest.fn();
    await expect(
      controller.getPublicMedia("a".repeat(65), FILE_A_KEY, fakeReq(), { redirect } as never),
    ).rejects.toThrow(NotFoundException);
    expect(mockValidateAttachment).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("throws HttpException with status 429 when the rate limit is exhausted before the service is called", async () => {
    mockRateLimitCheck.mockResolvedValue({ allowed: false });
    const redirect = jest.fn();
    let thrown: unknown;
    try {
      await controller.getPublicMedia(VALID_TOKEN, FILE_A_KEY, fakeReq(), { redirect } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("signs the file key returned by the service, not the raw client-supplied key", async () => {
    const dbKey = "org1/canonical-db-key.png";
    mockValidateAttachment.mockResolvedValue({ fileKey: dbKey, orgId: ORG_ID });

    await controller.getPublicMedia(VALID_TOKEN, "any-client-value", fakeReq(), { redirect: jest.fn() } as never);

    const [, fileKey] = mockGetFileUrl.mock.calls[0] as unknown[];
    expect(fileKey).toBe(dbKey);
  });
});
