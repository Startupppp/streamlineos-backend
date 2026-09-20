jest.mock("sharp", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    async (_db: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

import { Logger } from "@nestjs/common";
import { KbMediaService } from "./kb-media.service";
import type { StorageService, UploadResult } from "../../storage/storage.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { KbAttachmentIndexingService } from "../retrieval/kb-attachment-indexing.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { validateEnv } from "../../../config/env.validation";
import type { AvScanner } from "../../../common/security/av-scan";
import type { Db } from "../../../db/drizzle.module";

const KB_BUCKET = "kb-files";
const ORG = "org-42";

const baseConfig = validateEnv({
  DATABASE_URL: "postgres://test@localhost/kb_media_test",
  BACKEND_JWT_SECRET: "x".repeat(44),
  PORTAL_JWT_SECRET: "x".repeat(44),
  CORS_ORIGINS: "http://localhost",
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "x".repeat(32),
});

const COMPRESSED = Buffer.from([0x01, 0x02, 0x03]);
const JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const MOCK_RESULT: UploadResult = {
  key: `${ORG}/kb-media/${ORG}/2f1c9d0e-photo.webp`,
  size: COMPRESSED.length,
  mimeType: "image/webp",
  sha256: "aabbccddeeff00112233445566778899",
};

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
  role: "member",
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function makeFile(): Express.Multer.File {
  return {
    mimetype: "image/jpeg",
    buffer: JPEG_BUF,
    originalname: "photo.jpg",
    size: JPEG_BUF.length,
  } as unknown as Express.Multer.File;
}

interface Harness {
  service: KbMediaService;
  storage: {
    isConfigured: jest.Mock;
    uploadFile: jest.Mock;
    deleteFileIfPresent: jest.Mock;
  };
  scanner: { scan: jest.Mock };
  onConflictDoNothing: jest.Mock;
  findPage: jest.Mock;
  loggedErrors: string[];
}

/**
 * The insert chain is a real mock rather than a permissive proxy: the whole
 * point of these tests is which link rejected and what ran afterwards, and a
 * proxy that resolves everything cannot express that.
 */
function harness(kbBucket: string | undefined): Harness {
  const chain = {
    rotate: jest.fn(),
    resize: jest.fn(),
    webp: jest.fn(),
    toBuffer: jest.fn().mockResolvedValue(COMPRESSED),
  };
  chain.rotate.mockReturnValue(chain);
  chain.resize.mockReturnValue(chain);
  chain.webp.mockReturnValue(chain);
  jest.requireMock<{ default: jest.Mock }>("sharp").default.mockReturnValue(chain);

  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const findPage = jest.fn().mockResolvedValue({ id: 7 });
  const db = {
    query: { kbPages: { findFirst: findPage } },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ onConflictDoNothing }),
    }),
  } as unknown as Db;

  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    uploadFile: jest.fn().mockResolvedValue(MOCK_RESULT),
    deleteFileIfPresent: jest.fn().mockResolvedValue(true),
  };
  const scanner = { scan: jest.fn().mockResolvedValue({ status: "clean" }) };

  const loggedErrors: string[] = [];
  jest
    .spyOn(Logger.prototype, "error")
    .mockImplementation((message: unknown) => {
      loggedErrors.push(String(message));
    });

  const service = new KbMediaService(
    db,
    storage as unknown as StorageService,
    { log: jest.fn() } as unknown as AuditService,
    {} as unknown as KbAttachmentIndexingService,
    { ...baseConfig, R2_KB_BUCKET_NAME: kbBucket },
    scanner as unknown as AvScanner,
  );

  return { service, storage, scanner, onConflictDoNothing, findPage, loggedErrors };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

/**
 * KB media keeps both the scan and the object write on the request path, which
 * is only safe while the scan verdict is known BEFORE any byte reaches the
 * bucket. Deferring either half would break a different guarantee — the editor
 * renders the returned key immediately — so this ordering is the whole of the
 * argument and is pinned here rather than left to the reading of the method.
 */
describe("KB media — nothing is written before a clean verdict", () => {
  it("the scan completes before uploadFile is ever invoked", async () => {
    const h = harness(KB_BUCKET);
    await h.service.upload(makeFile(), USER);

    const scanOrder = h.scanner.scan.mock.invocationCallOrder[0];
    const uploadOrder = h.storage.uploadFile.mock.invocationCallOrder[0];
    expect(scanOrder).toBeDefined();
    expect(uploadOrder).toBeDefined();
    expect(Number(scanOrder)).toBeLessThan(Number(uploadOrder));
  });

  it("BITE — an infected verdict leaves the bucket untouched", async () => {
    const h = harness(KB_BUCKET);
    h.scanner.scan.mockResolvedValue({ status: "infected", threat: "Eicar-Test-Signature" });

    await expect(h.service.upload(makeFile(), USER)).rejects.toMatchObject({ status: 422 });
    expect(h.storage.uploadFile).not.toHaveBeenCalled();
  });

  it("BITE — an unavailable scanner leaves the bucket untouched", async () => {
    const h = harness(KB_BUCKET);
    h.scanner.scan.mockResolvedValue({ status: "error", reason: "vt-unknown-hash" });

    await expect(h.service.upload(makeFile(), USER)).rejects.toMatchObject({ status: 503 });
    expect(h.storage.uploadFile).not.toHaveBeenCalled();
  });
});

/**
 * A `kb-media` key resolves to its organisation off the key alone, so
 * `assertKeyReadable` never reads this table and an object whose row never
 * landed stays readable by the whole tenant; and both KB purge paths enumerate
 * `kb_page_attachments`, so nothing would ever collect it.
 */
describe("KB media — a failed attachment row takes its object with it", () => {
  it("deletes the uploaded object when the row insert rejects", async () => {
    const h = harness(KB_BUCKET);
    h.onConflictDoNothing.mockRejectedValue(new Error("insert failed"));

    await expect(h.service.upload(makeFile(), USER, 7)).rejects.toThrow("insert failed");
    expect(h.storage.deleteFileIfPresent).toHaveBeenCalledTimes(1);
    expect(h.storage.deleteFileIfPresent).toHaveBeenCalledWith(ORG, MOCK_RESULT.key, KB_BUCKET);
  });

  it("passes undefined when no dedicated KB bucket is configured, so the default bucket is used", async () => {
    const h = harness(undefined);
    h.onConflictDoNothing.mockRejectedValue(new Error("insert failed"));

    await expect(h.service.upload(makeFile(), USER, 7)).rejects.toThrow("insert failed");
    expect(h.storage.deleteFileIfPresent).toHaveBeenCalledWith(ORG, MOCK_RESULT.key, undefined);
  });

  it("CONTROL — a successful row insert deletes nothing", async () => {
    const h = harness(KB_BUCKET);
    await h.service.upload(makeFile(), USER, 7);
    expect(h.storage.deleteFileIfPresent).not.toHaveBeenCalled();
  });

  it("a failed cleanup is reported and does not mask the row failure", async () => {
    const h = harness(KB_BUCKET);
    h.onConflictDoNothing.mockRejectedValue(new Error("insert failed"));
    h.storage.deleteFileIfPresent.mockRejectedValue(new Error("r2 unreachable"));

    await expect(h.service.upload(makeFile(), USER, 7)).rejects.toThrow("insert failed");
    expect(h.loggedErrors.some((line) => line.includes("Orphaned KB object"))).toBe(true);
    expect(h.loggedErrors.some((line) => line.includes("r2 unreachable"))).toBe(true);
  });

  it("never reaches the object store when the page is not the caller's, so there is nothing to compensate", async () => {
    const h = harness(KB_BUCKET);
    h.findPage.mockResolvedValue(undefined);

    await expect(h.service.upload(makeFile(), USER, 999)).rejects.toMatchObject({ status: 404 });
    expect(h.storage.uploadFile).not.toHaveBeenCalled();
    expect(h.storage.deleteFileIfPresent).not.toHaveBeenCalled();
  });
});
