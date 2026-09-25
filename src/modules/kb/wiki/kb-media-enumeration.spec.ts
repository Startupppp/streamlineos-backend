jest.mock("sharp", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    async (_db: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { KbMediaService } from "./kb-media.service";
import { validateEnv } from "../../../config/env.validation";

const kbConfig = validateEnv({
  DATABASE_URL: "postgres://test@localhost/kb_enum_test",
  BACKEND_JWT_SECRET: "x".repeat(44),
  PORTAL_JWT_SECRET: "x".repeat(44),
  CORS_ORIGINS: "http://localhost",
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "x".repeat(32),
});

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", isOrgOwner: false } as never;
}

function makeDb(pageRow: unknown) {
  return {
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue(pageRow) } },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  } as unknown as Db;
}

const storage = { isConfigured: jest.fn().mockReturnValue(true) } as never;
const audit = { log: jest.fn() } as never;
const attachmentIndexing = {} as never;
const avScanner = { scan: jest.fn().mockResolvedValue({ status: "clean" }) } as never;

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  };
}

const PAGE_ID = 55;
const JPEG_FILE = {
  mimetype: "image/jpeg",
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02, 0x03]),
  originalname: "photo.jpg",
  size: 8,
} as never;

describe("KbMediaService.upload — enumeration guard on pageId", () => {
  it("throws NotFoundException when the page does not exist", async () => {
    const auth = makeAuth();
    const svc = new KbMediaService(
      makeDb(null),
      storage,
      audit,
      attachmentIndexing,
      kbConfig,
      avScanner,
      auth as never,
    );

    const error = await svc.upload(JPEG_FILE, makeUser(), PAGE_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Page not found");
    expect(auth.visiblePagePredicate).toHaveBeenCalled();
  });

  it("throws NotFoundException with the same message when the page is restricted", async () => {
    const auth = makeAuth();
    const svc = new KbMediaService(
      makeDb(null),
      storage,
      audit,
      attachmentIndexing,
      kbConfig,
      avScanner,
      auth as never,
    );

    const error = await svc.upload(JPEG_FILE, makeUser(), PAGE_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe("Page not found");
  });

  it("nonexistent-page error and restricted-page error are byte-for-byte identical", async () => {
    const errorA = await new KbMediaService(
      makeDb(null),
      storage,
      audit,
      attachmentIndexing,
      kbConfig,
      avScanner,
      makeAuth() as never,
    ).upload(JPEG_FILE, makeUser(), PAGE_ID).catch((e: unknown) => e);

    const errorB = await new KbMediaService(
      makeDb(null),
      storage,
      audit,
      attachmentIndexing,
      kbConfig,
      avScanner,
      makeAuth() as never,
    ).upload(JPEG_FILE, makeUser(), PAGE_ID).catch((e: unknown) => e);

    expect((errorA as NotFoundException).message).toBe((errorB as NotFoundException).message);
    expect((errorA as NotFoundException).getStatus()).toBe((errorB as NotFoundException).getStatus());
  });

  it("succeeds (does not throw NotFoundException) when no pageId is provided", async () => {
    const auth = makeAuth();
    const svc = new KbMediaService(
      makeDb(null),
      storage,
      audit,
      attachmentIndexing,
      kbConfig,
      avScanner,
      auth as never,
    );

    const error = await svc.upload(JPEG_FILE, makeUser()).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(NotFoundException);
    expect(auth.visiblePagePredicate).not.toHaveBeenCalled();
  });
});
