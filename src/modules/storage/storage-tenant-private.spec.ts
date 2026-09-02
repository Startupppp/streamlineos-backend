import { NotFoundException } from "@nestjs/common";
import { StorageController } from "./storage.controller";
import { MediaTransformRunner } from "./media-transform.runner";
import { StorageService } from "./storage.service";
import type { AppConfig } from "../../config/env.validation";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import {
  isForeignOrgKey,
  isSensitiveStorageKey,
  parseStorageKey,
  sanitizeFileName,
  sanitizeFolder,
} from "./storage-key";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function storageConfig(): AppConfig {
  return {
    NODE_ENV: "test",
    RBAC_MIGRATION_MODE: "off",
    PORT: 1500,
    DATABASE_URL: "postgres://test",
    BACKEND_JWT_SECRET: "x".repeat(44),
    PORTAL_JWT_SECRET: "x".repeat(44),
    CORS_ORIGINS: "http://localhost",
    APP_URL: "http://localhost:3000",
    ENCRYPTION_KEY: "x".repeat(32),
    corsOrigins: ["http://localhost"],
    R2_REGION: "auto",
    R2_BUCKET_NAME: "files",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_ENDPOINT: "https://r2.example",
    NEXT_PUBLIC_R2_PUBLIC_URL: "https://pub-cdn.example.com",
  } as AppConfig;
}

function ctx(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function mockRes() {
  return {
    setHeader: jest.fn(),
    json: jest.fn(),
  } as unknown as import("express").Response;
}

/**
 * The regression this file exists for. A public base URL is configured, and no
 * upload path may turn it into a stored reference: everything the seam hands
 * back has to be an opaque key that only a signed, re-authorized read resolves.
 */
describe("StorageService — no upload path mints a permanent public URL", () => {
  const compression = {
    planOutput: jest.fn().mockReturnValue({ fileName: "a.pdf", mimeType: "application/pdf" }),
    compress: jest.fn().mockResolvedValue({
      buffer: Buffer.from("x"),
      fileName: "a.pdf",
      mimeType: "application/pdf",
    }),
  };

  it("returns an object key, never the configured public base, from the planned path", async () => {
    const service = new StorageService(compression as never, storageConfig());

    const result = await service.planUpload(
      ORG_A,
      Buffer.from("x"),
      "uploads",
      "a.pdf",
      "application/pdf",
    );

    expect(result.key.startsWith(`${ORG_A}/uploads/`)).toBe(true);
    expect(result).not.toHaveProperty("url");
    expect(JSON.stringify(result)).not.toContain("pub-cdn.example.com");
  });

  it("scopes every generated key to the organisation that owns it", async () => {
    const service = new StorageService(compression as never, storageConfig());

    const a = await service.planUpload(
      ORG_A,
      Buffer.from("x"),
      "uploads",
      "a.pdf",
      "application/pdf",
    );
    const b = await service.planUpload(
      ORG_B,
      Buffer.from("x"),
      "uploads",
      "a.pdf",
      "application/pdf",
    );

    expect(isForeignOrgKey(a.key, ORG_A)).toBe(false);
    expect(isForeignOrgKey(a.key, ORG_B)).toBe(true);
    expect(isForeignOrgKey(b.key, ORG_A)).toBe(true);
  });
});

describe("storage key seam", () => {
  it("reads the owning organisation off an organisation-scoped key", () => {
    expect(parseStorageKey(`${ORG_B}/documents/x.pdf`, ORG_A)).toEqual({
      ownerOrgId: ORG_B,
      folderRoot: "documents",
    });
  });

  it("reads the owning organisation off an organisation-namespaced folder key", () => {
    expect(parseStorageKey("kb-media/org-B/x.png", "org-A")).toEqual({
      ownerOrgId: "org-B",
      folderRoot: "kb-media",
    });
  });

  it("leaves a legacy folder-first key unowned rather than guessing", () => {
    expect(parseStorageKey("uploads/plain.pdf", ORG_A)).toEqual({
      ownerOrgId: null,
      folderRoot: "uploads",
    });
  });

  /**
   * The prefix list used to be matched against the whole key, which stopped
   * matching the moment keys gained their organisation segment — so every
   * sensitive folder read as non-sensitive.
   */
  it("classifies a sensitive folder in both key shapes", () => {
    expect(isSensitiveStorageKey("payroll/run-9/payslip.pdf", ORG_A)).toBe(true);
    expect(isSensitiveStorageKey(`${ORG_A}/payroll/run-9/payslip.pdf`, ORG_A)).toBe(true);
    expect(isSensitiveStorageKey(`${ORG_A}/uploads/photo.png`, ORG_A)).toBe(false);
  });

  it("strips traversal and path separators out of an uploaded file name", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName("a b/c\\d.pdf")).toBe("d.pdf");
  });

  it("never lets a client-supplied folder escape its segment", () => {
    expect(sanitizeFolder("../secrets")).toBe("secrets");
    expect(sanitizeFolder("payroll/../uploads")).toBe("payroll-uploads");
    expect(sanitizeFolder("")).toBe("uploads");
  });
});

describe("StorageController — a client-supplied key is an input, not a fact", () => {
  function build(overrides: { isKeyBlocked?: boolean } = {}) {
    const empty = { findFirst: jest.fn().mockResolvedValue(null) };
    const db = {
      query: {
        documents: empty,
        onboardingDocuments: empty,
        expenses: empty,
        reimbursements: empty,
        handbookVersions: empty,
        payslipPublications: empty,
        candidateDocumentsVault: empty,
      },
    };
    const storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileKeyFromUrl: jest.fn((v: string) => v),
      getFileUrl: jest.fn().mockResolvedValue("https://signed.example.com/file"),
      getMimeType: jest.fn().mockReturnValue("image/webp"),
      getFileStream: jest.fn().mockResolvedValue({
        body: { on: jest.fn(), pipe: jest.fn() },
        contentType: "image/webp",
        contentLength: 10,
      }),
    };
    const quarantine = {
      isKeyBlocked: jest.fn().mockResolvedValue(overrides.isKeyBlocked ?? false),
      getTotalUsageBytes: jest.fn().mockResolvedValue(0),
      getTotalUsageBytesForUser: jest.fn().mockResolvedValue(0),
      begin: jest.fn().mockResolvedValue("qr-1"),
      markClean: jest.fn(),
      markError: jest.fn(),
      softDelete: jest.fn(),
    };
    const controller = new StorageController(
      db as never,
      storage as never,
      { log: jest.fn() } as never,
      { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as never,
      { scan: jest.fn() } as never,
      quarantine as never,
      new MediaTransformRunner(),
    );
    return { controller, storage, quarantine };
  }

  it("404s a download for a key naming another organisation, before any table lookup", async () => {
    const { controller, storage } = build();

    await expect(
      controller.download(
        { key: `${ORG_B}/uploads/secret.pdf`, expiresIn: 3600 },
        ctx(ORG_A),
        mockRes(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("404s an image render for a key naming another organisation", async () => {
    const { controller, storage } = build();

    await expect(
      controller.image({ key: `${ORG_B}/uploads/secret.png` }, ctx(ORG_A), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });

  it("serves the caller's own organisation-scoped key (control)", async () => {
    const { controller } = build();
    const res = mockRes();

    await controller.download(
      { key: `${ORG_A}/uploads/mine.pdf`, expiresIn: 3600 },
      ctx(ORG_A),
      res,
    );

    expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example.com/file" });
  });

  /**
   * The image path used to skip the quarantine entirely, so an unscanned or
   * infected object was unreachable through /storage/download and served
   * happily through /storage/image.
   */
  it("404s an image render for a quarantine-blocked key", async () => {
    const { controller, storage } = build({ isKeyBlocked: true });

    await expect(
      controller.image({ key: `${ORG_A}/uploads/pending.png` }, ctx(ORG_A), mockRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getFileStream).not.toHaveBeenCalled();
  });

  it("404s a sensitive-folder key in the organisation-scoped shape when no table tracks it", async () => {
    const { controller } = build();

    await expect(
      controller.download(
        { key: `${ORG_A}/payroll/run-9/payslip.pdf`, expiresIn: 3600 },
        ctx(ORG_A),
        mockRes(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
