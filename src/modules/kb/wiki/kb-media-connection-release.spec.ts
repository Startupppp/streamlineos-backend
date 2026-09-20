jest.mock("sharp", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { KbMediaController } from "./kb-media.controller";
import { KbMediaService } from "./kb-media.service";
import type { StorageService, UploadResult } from "../../storage/storage.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { KbAttachmentIndexingService } from "../retrieval/kb-attachment-indexing.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { validateEnv } from "../../../config/env.validation";
import type { AvScanner } from "../../../common/security/av-scan";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-release";
const COMPRESSED = Buffer.from([0x01, 0x02, 0x03]);
const JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const MOCK_RESULT: UploadResult = {
  key: `${ORG}/kb-media/photo.webp`,
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

const baseConfig = validateEnv({
  DATABASE_URL: "postgres://test@localhost/kb_media_test",
  BACKEND_JWT_SECRET: "x".repeat(44),
  PORTAL_JWT_SECRET: "x".repeat(44),
  CORS_ORIGINS: "http://localhost",
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "x".repeat(32),
});

function transactionMock(): jest.Mock {
  return jest.requireMock<{ runInTenantTransaction: jest.Mock }>(
    "../../../common/tenant/run-in-tenant-transaction",
  ).runInTenantTransaction;
}

interface DepthTrace {
  readonly service: KbMediaService;
  readonly depthAt: Map<string, number>;
  readonly runInTenantTransaction: jest.Mock;
}

function traceDepth(): DepthTrace {
  const depthAt = new Map<string, number>();
  let depth = 0;
  const record = (step: string): void => {
    depthAt.set(step, depth);
  };

  const runInTenantTransaction = transactionMock();
  runInTenantTransaction.mockImplementation(
    async (_db: unknown, fn: () => Promise<unknown>) => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    },
  );

  const chain = {
    rotate: jest.fn(),
    resize: jest.fn(),
    webp: jest.fn(),
    toBuffer: jest.fn().mockImplementation(() => {
      record("encode");
      return Promise.resolve(COMPRESSED);
    }),
  };
  chain.rotate.mockReturnValue(chain);
  chain.resize.mockReturnValue(chain);
  chain.webp.mockReturnValue(chain);
  jest.requireMock<{ default: jest.Mock }>("sharp").default.mockReturnValue(chain);

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockImplementation(() => {
          record("pageLookup");
          return Promise.resolve({ id: 7 });
        }),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockImplementation(() => {
          record("attachmentWrite");
          return Promise.resolve(undefined);
        }),
      }),
    }),
  } as unknown as Db;

  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    uploadFile: jest.fn().mockImplementation(() => {
      record("objectStoreUpload");
      return Promise.resolve(MOCK_RESULT);
    }),
    deleteFileIfPresent: jest.fn().mockResolvedValue(true),
  };

  const scanner = {
    scan: jest.fn().mockImplementation(() => {
      record("malwareScan");
      return Promise.resolve({ status: "clean" });
    }),
  };

  const service = new KbMediaService(
    db,
    storage as unknown as StorageService,
    { log: jest.fn() } as unknown as AuditService,
    {} as unknown as KbAttachmentIndexingService,
    { ...baseConfig, R2_KB_BUCKET_NAME: "kb-files" },
    scanner as unknown as AvScanner,
  );

  return { service, depthAt, runInTenantTransaction };
}

function jpegUpload(): Express.Multer.File {
  return {
    mimetype: "image/jpeg",
    buffer: JPEG_BUF,
    originalname: "photo.jpg",
    size: JPEG_BUF.length,
  } as unknown as Express.Multer.File;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe("KbMediaController — the upload route opts out of the ambient tenant transaction", () => {
  it("upload carries @NoTenantTransaction() so the CPU-bound sharp encode and the S3 upload do not hold a pooled connection for their full duration", () => {
    const handler: unknown = Reflect.get(KbMediaController.prototype, "upload");
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(handler))).toBe(true);
  });
});

describe("KbMediaService.upload — where the pooled connection is held", () => {
  it("runs the malware scan, the image encode and the object-store upload with no transaction open, because none of the three touches the database", async () => {
    const { service, depthAt } = traceDepth();

    await service.upload(jpegUpload(), USER, 7);

    expect(depthAt.get("malwareScan")).toBe(0);
    expect(depthAt.get("encode")).toBe(0);
    expect(depthAt.get("objectStoreUpload")).toBe(0);
  });

  it("keeps both database touches inside a transaction, so opting the route out never issues a statement without a tenant GUC", async () => {
    const { service, depthAt } = traceDepth();

    await service.upload(jpegUpload(), USER, 7);

    expect(depthAt.get("pageLookup")).toBe(1);
    expect(depthAt.get("attachmentWrite")).toBe(1);
  });

  it("opens exactly two short transactions rather than one spanning the whole upload", async () => {
    const { service, runInTenantTransaction } = traceDepth();

    await service.upload(jpegUpload(), USER, 7);

    expect(runInTenantTransaction).toHaveBeenCalledTimes(2);
    expect(runInTenantTransaction).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Function),
      { orgId: ORG },
    );
  });
});
