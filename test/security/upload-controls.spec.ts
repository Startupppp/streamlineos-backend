/**
 * upload-controls.spec.ts
 *
 * Upload type, size, magic-byte, malware and sensitive-download controls on
 * `StorageController`, asserted by DRIVING the controller rather than by
 * reading its source.
 *
 * WHY THIS WAS REWRITTEN. Every assertion here used to be
 * `controllerSrc.indexOf("uploadToKey")` and friends: string matches against
 * `src/modules/storage/storage.controller.ts`. Five of them went red when
 * `uploadToKey` moved into `storage.service.ts` and the sensitive-key predicate
 * moved into `storage-key.ts` — refactors that changed no behaviour at all.
 * That is the failure mode of a source-text security gate: it is type-clean by
 * construction so no typecheck sees it drift, it fires on a rename, and it stays
 * green through any regression that keeps the matched string. Ordering
 * assertions built on `indexOf` are worse still — they compare the positions of
 * two substrings in a file, which is not the order the code executes in.
 *
 * What is asserted now is the order the gates actually run in, observed through
 * the collaborators: an upload that is refused must not have reached the AV
 * scanner or the object store, and each denial must carry its own status.
 *
 * Findings register:
 *   F1 — RESOLVED. The multer body limit and the application limit were 50 MB
 *        and 10 MB, so a 40 MB body was fully buffered before being rejected.
 *        They are equal now, and the test below proves the equality by reading
 *        the interceptor's real multer limit and driving the controller at that
 *        exact boundary — no literal is duplicated into the spec.
 *   F2 — `validateMagicBytes` returns true for a mime type it has no signature
 *        for. SAFE as composed: `ALLOWED_UPLOAD_TYPES` is an explicit allowlist
 *        and an unlisted type is refused before the magic-byte check runs. Both
 *        halves of that argument are asserted, so if the allowlist were widened
 *        past `FILE_SIGNATURES` the composition test would still hold but the
 *        recorded reasoning stays visible.
 *   F3 — RESOLVED. An AV scan runs, and it runs before the key is planned.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import { INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import type { Response } from "express";
import { Test } from "@nestjs/testing";
import { JwtAuthGuard } from "../../src/common/auth/jwt-auth.guard";
import { humanSessionPrincipal } from "../../src/common/auth/principal";
import type { CurrentUserContext } from "../../src/common/auth/backend-claims";
import { AuditService } from "../../src/common/audit/audit.service";
import { AvScanner } from "../../src/common/security/av-scan";
import { DRIZZLE } from "../../src/db/drizzle.constants";
import { AccessService } from "../../src/modules/access/access.service";
import { FileQuarantineService } from "../../src/modules/storage/file-quarantine.service";
import { validateMagicBytes } from "../../src/modules/storage/file-signatures";
import { MediaTransformRunner } from "../../src/modules/storage/media-transform.runner";
import { StorageController } from "../../src/modules/storage/storage.controller";
import { StorageService } from "../../src/modules/storage/storage.service";

const BACKEND_ROOT = join(__dirname, "../..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_ROOT, rel), "utf8");
}

const ORG = "org-A";

const MAGIC: Readonly<Record<string, Buffer>> = {
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  "application/pdf": Buffer.from([0x25, 0x50, 0x44, 0x46]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Buffer.from([
    0x50, 0x4b, 0x03, 0x04,
  ]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": Buffer.from([
    0x50, 0x4b, 0x03, 0x04,
  ]),
};

function user(orgId = ORG): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function fileOf(mimetype: string, body: Buffer, size = body.length): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "upload.bin",
    encoding: "7bit",
    mimetype,
    size,
    buffer: body,
    stream: Readable.from(body),
    destination: "",
    filename: "upload.bin",
    path: "",
  };
}

/** Only `json` and `setHeader` are reached on the paths driven here. */
function mockRes(): Response {
  return { json: jest.fn(), setHeader: jest.fn(), status: jest.fn(), end: jest.fn() } as never;
}

/**
 * The size multer itself is configured to accept, read off the real interceptor
 * the controller is decorated with. Nothing in this file repeats the literal.
 */
function interceptorFileSizeLimit(): number {
  const interceptors = Reflect.getMetadata(
    INTERCEPTORS_METADATA,
    StorageController.prototype.upload,
  ) as Array<new () => { multer: { limits?: { fileSize?: number } } }>;
  expect(interceptors).toHaveLength(1);
  const instance = new interceptors[0]!();
  const limit = instance.multer.limits?.fileSize;
  expect(typeof limit).toBe("number");
  return limit as number;
}

const EMPTY_TABLE = () => ({ findFirst: jest.fn().mockResolvedValue(undefined) });

function tenantTransactionSupport(query: Record<string, unknown>) {
  const tx = { query, execute: jest.fn().mockResolvedValue([]) };
  const relocationTargets = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  return {
    select: jest.fn().mockReturnValue(relocationTargets),
    transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
  };
}

describe("StorageController upload and download controls", () => {
  let controller: StorageController;
  let storage: {
    isConfigured: jest.Mock;
    isValidFileKey: jest.Mock;
    getFileKeyFromUrl: jest.Mock;
    getFileUrl: jest.Mock;
    planUpload: jest.Mock;
    compressToKey: jest.Mock;
    deleteFileIfPresent: jest.Mock;
    getFileStream: jest.Mock;
    getMimeType: jest.Mock;
    getFileNameFromKey: jest.Mock;
  };
  let scanner: { scan: jest.Mock };
  let quarantine: {
    isKeyBlocked: jest.Mock;
    getTotalUsageBytes: jest.Mock;
    getTotalUsageBytesForUser: jest.Mock;
    begin: jest.Mock;
    markClean: jest.Mock;
    markError: jest.Mock;
    recordMeasuredObject: jest.Mock;
    softDelete: jest.Mock;
  };
  let db: {
    query: Record<string, { findFirst: jest.Mock }>;
    select: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    storage = {
      isConfigured: jest.fn().mockReturnValue(true),
      isValidFileKey: jest.fn().mockReturnValue(true),
      getFileKeyFromUrl: jest.fn().mockReturnValue(""),
      getFileUrl: jest.fn().mockResolvedValue("https://signed.example/x"),
      planUpload: jest
        .fn()
        .mockResolvedValue({ key: `${ORG}/uploads/x.png`, plannedMimeType: "image/png" }),
      compressToKey: jest.fn().mockResolvedValue({ size: 4, mimeType: "image/png" }),
      deleteFileIfPresent: jest.fn().mockResolvedValue(true),
      getFileStream: jest.fn().mockResolvedValue({ body: Readable.from("x"), contentType: "image/png" }),
      getMimeType: jest.fn().mockReturnValue("image/png"),
      getFileNameFromKey: jest.fn().mockReturnValue("x.png"),
    };
    scanner = { scan: jest.fn().mockResolvedValue({ status: "clean" }) };
    quarantine = {
      isKeyBlocked: jest.fn().mockResolvedValue(false),
      getTotalUsageBytes: jest.fn().mockResolvedValue(0),
      getTotalUsageBytesForUser: jest.fn().mockResolvedValue(0),
      begin: jest.fn().mockResolvedValue("qr-1"),
      markClean: jest.fn(),
      markError: jest.fn(),
      recordMeasuredObject: jest.fn(),
      softDelete: jest.fn(),
    };
    const query = {
      documents: EMPTY_TABLE(),
      onboardingDocuments: EMPTY_TABLE(),
      expenses: EMPTY_TABLE(),
      reimbursements: EMPTY_TABLE(),
      handbookVersions: EMPTY_TABLE(),
      payslipPublications: EMPTY_TABLE(),
      candidateDocumentsVault: EMPTY_TABLE(),
    };
    db = { query, ...tenantTransactionSupport(query) };

    const moduleRef = await Test.createTestingModule({
      controllers: [StorageController],
      providers: [
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: storage },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } },
        { provide: AvScanner, useValue: scanner },
        { provide: FileQuarantineService, useValue: quarantine },
        { provide: MediaTransformRunner, useValue: { hasCapacity: () => true, submit: () => true } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(StorageController);
  });

  describe("upload type allowlist", () => {
    it("accepts each declared type and refuses one that is not on the list", async () => {
      for (const [mime, magic] of Object.entries(MAGIC)) {
        await expect(controller.upload(fileOf(mime, magic), "uploads", user())).resolves.toMatchObject({
          status: "pending_scan",
        });
      }
      expect(storage.planUpload).toHaveBeenCalledTimes(Object.keys(MAGIC).length);

      storage.planUpload.mockClear();
      scanner.scan.mockClear();
      for (const mime of ["text/html", "application/x-msdownload", "image/svg+xml", "application/zip"]) {
        await expect(
          controller.upload(fileOf(mime, Buffer.from([0x50, 0x4b, 0x03, 0x04])), "uploads", user()),
        ).rejects.toThrow("File type not allowed");
      }
      expect(storage.planUpload).not.toHaveBeenCalled();
      expect(scanner.scan).not.toHaveBeenCalled();
    });
  });

  describe("upload size limit", () => {
    it("F1 FIX VERIFIED — multer's own limit and the application limit are the same number", () => {
      const limit = interceptorFileSizeLimit();
      expect(limit).toBe(10 * 1024 * 1024);
    });

    it("refuses a file one byte over the interceptor's limit and accepts one exactly at it", async () => {
      const limit = interceptorFileSizeLimit();
      const png = MAGIC["image/png"]!;

      await expect(
        controller.upload(fileOf("image/png", png, limit + 1), "uploads", user()),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.upload(fileOf("image/png", png, limit + 1), "uploads", user()),
      ).rejects.toThrow("File too large (max 10MB)");
      expect(scanner.scan).not.toHaveBeenCalled();
      expect(storage.planUpload).not.toHaveBeenCalled();

      await expect(
        controller.upload(fileOf("image/png", png, limit), "uploads", user()),
      ).resolves.toMatchObject({ status: "pending_scan" });
    });

    it("refuses an upload that would cross the org or per-user quota, before the object store is touched", async () => {
      const png = MAGIC["image/png"]!;
      quarantine.getTotalUsageBytes.mockResolvedValue(5 * 1024 * 1024 * 1024);
      await expect(
        controller.upload(fileOf("image/png", png), "uploads", user()),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);

      quarantine.getTotalUsageBytes.mockResolvedValue(0);
      quarantine.getTotalUsageBytesForUser.mockResolvedValue(500 * 1024 * 1024);
      await expect(
        controller.upload(fileOf("image/png", png), "uploads", user()),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);

      expect(storage.planUpload).not.toHaveBeenCalled();
    });
  });

  describe("magic-byte validation", () => {
    it("refuses a body whose leading bytes do not match the declared type, before the scan and the store", async () => {
      const mismatches: Array<[string, Buffer]> = [
        ["image/png", MAGIC["image/jpeg"]!],
        ["image/jpeg", MAGIC["application/pdf"]!],
        ["application/pdf", Buffer.from("<html><script>alert(1)</script>")],
        ["image/png", Buffer.from("MZ\x90\x00")],
      ];
      for (const [mime, body] of mismatches) {
        await expect(controller.upload(fileOf(mime, body), "uploads", user())).rejects.toThrow(
          "File content does not match declared type",
        );
      }
      expect(scanner.scan).not.toHaveBeenCalled();
      expect(storage.planUpload).not.toHaveBeenCalled();
    });

    it("FILE_SIGNATURES covers JPEG, PNG and PDF — the right header passes, a wrong one does not", () => {
      for (const mime of ["image/jpeg", "image/png", "application/pdf"]) {
        expect({ mime, ok: validateMagicBytes(MAGIC[mime]!, mime) }).toEqual({ mime, ok: true });
        expect({ mime, ok: validateMagicBytes(Buffer.from("not-this-format"), mime) }).toEqual({
          mime,
          ok: false,
        });
      }
    });

    /**
     * REWRITTEN, and it now asserts the STRONGER behaviour rather than the one it found.
     *
     * This case used to pin `validateMagicBytes(…, "application/x-msdownload") === true` — an
     * unlisted MIME skipped magic-byte validation entirely, so the type allowlist was the only
     * thing standing in front of a declared `application/x-anything`, and the declared type is
     * the one input the caller fully controls. `299cd1009` made the table fail CLOSED. The
     * assertion is flipped to `false` to hold that, not relaxed: an accepted type must be one
     * this file can actually verify, and the allowlist is now the SECOND refusal rather than
     * the only one. The defence-in-depth half is asserted below it.
     */
    it("F2 — an unlisted mime fails validateMagicBytes closed, and the type allowlist refuses it too", async () => {
      expect(validateMagicBytes(Buffer.from("MZ\x90\x00"), "application/x-msdownload")).toBe(false);
      expect(validateMagicBytes(MAGIC["application/pdf"]!, "application/x-anything")).toBe(false);

      await expect(
        controller.upload(fileOf("application/x-msdownload", Buffer.from("MZ\x90\x00")), "uploads", user()),
      ).rejects.toThrow("File type not allowed");
      expect(storage.planUpload).not.toHaveBeenCalled();
    });
  });

  describe("malware scan", () => {
    it("F3 RESOLVED — an infected body is refused 422 and never reaches the object store", async () => {
      scanner.scan.mockResolvedValue({ status: "infected", threat: "Eicar-Test-Signature" });
      await expect(
        controller.upload(fileOf("image/png", MAGIC["image/png"]!), "uploads", user()),
      ).rejects.toMatchObject({ status: 422 });
      expect(scanner.scan).toHaveBeenCalledTimes(1);
      expect(storage.planUpload).not.toHaveBeenCalled();
    });

    it("fails closed when the scanner is unavailable rather than storing an unscanned object", async () => {
      scanner.scan.mockResolvedValue({ status: "error" });
      await expect(
        controller.upload(fileOf("image/png", MAGIC["image/png"]!), "uploads", user()),
      ).rejects.toMatchObject({ status: 503 });
      expect(storage.planUpload).not.toHaveBeenCalled();
    });

    it("the scan runs BEFORE the key is planned — the order, observed, not the source order", async () => {
      await controller.upload(fileOf("image/png", MAGIC["image/png"]!), "uploads", user());
      expect(scanner.scan).toHaveBeenCalledTimes(1);
      expect(storage.planUpload).toHaveBeenCalledTimes(1);
      expect(scanner.scan.mock.invocationCallOrder[0]!).toBeLessThan(
        storage.planUpload.mock.invocationCallOrder[0]!,
      );
    });
  });

  describe("sensitive download controls", () => {
    const SENSITIVE_ROOTS = [
      "payroll",
      "payroll-exports",
      "payslips",
      "hr",
      "hr-documents",
      "hr-exports",
      "documents",
      "onboarding",
      "onboarding-docs",
      "resignations",
      "candidates",
      "candidate-vault",
      "esign",
      "signatures",
      "bank-batches",
      "gdpr-exports",
      "expense-exports",
      "fin-report-exports",
    ];

    it("refuses an untracked key under every sensitive folder root, on the caller's own org prefix", async () => {
      for (const root of SENSITIVE_ROOTS) {
        for (const key of [`${root}/secret.pdf`, `${ORG}/${root}/secret.pdf`]) {
          await expect(
            controller.download({ key, expiresIn: 3600 }, user(), mockRes()),
          ).rejects.toMatchObject({ status: 404 });
        }
      }
      expect(storage.getFileUrl).not.toHaveBeenCalled();
    });

    it("refuses a tracked HR document even inside the caller's own org — it needs its own endpoint", async () => {
      db.query.documents.findFirst.mockResolvedValue({ orgId: ORG });
      await expect(
        controller.download({ key: `${ORG}/uploads/hr.pdf`, expiresIn: 3600 }, user(), mockRes()),
      ).rejects.toMatchObject({ status: 403 });
      expect(storage.getFileUrl).not.toHaveBeenCalled();
    });

    it("refuses a key that names another organisation before any table is consulted", async () => {
      await expect(
        controller.download(
          { key: "11111111-2222-3333-4444-555555555555/uploads/x.pdf", expiresIn: 3600 },
          user(),
          mockRes(),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(db.query.documents.findFirst).not.toHaveBeenCalled();
      expect(storage.getFileUrl).not.toHaveBeenCalled();
    });

    it("refuses a key the quarantine still blocks, so an unscanned object is unreachable", async () => {
      quarantine.isKeyBlocked.mockResolvedValue(true);
      await expect(
        controller.download({ key: `${ORG}/uploads/x.png`, expiresIn: 3600 }, user(), mockRes()),
      ).rejects.toMatchObject({ status: 404 });
      expect(storage.getFileUrl).not.toHaveBeenCalled();
    });

    it("CONTROL: an ordinary same-org key is served, so the denials above are not a blanket 404", async () => {
      const res = mockRes();
      await controller.download({ key: `${ORG}/uploads/x.png`, expiresIn: 3600 }, user(), res);
      /**
       * The full argument list, not a prefix. `299cd1009` added the `{ preauthorized: true }`
       * option, which tells `StorageService.getFileUrl` that the controller has ALREADY run
       * `assertKeyReadable` and it need not repeat the check. That flag is an authorization
       * claim, so it is asserted here rather than allowed to arrive unobserved: a handler that
       * set it without the preceding assertion would be signing any key in the org.
       */
      expect(storage.getFileUrl).toHaveBeenCalledWith(ORG, `${ORG}/uploads/x.png`, 3600, undefined, {
        preauthorized: true,
      });
      expect(res.json).toHaveBeenCalledWith({ url: "https://signed.example/x" });
    });
  });
});

/*
 * F4's pin. This block is deliberately NOT static like the rest of the file:
 * the claim is about which code actually runs, and the source text cannot say
 * that — package.json shows `multer` at the patched range while the tree quietly
 * resolves 2.2.0 underneath platform-express. So it asks the module resolver,
 * from platform-express's own directory, which is the question that matters.
 */
describe("the multer that actually serves uploads is the patched one", () => {
  const MINIMUM = [2, 3, 0]; // the advisory floor: DoS via crafted field names

  function resolvedMulterVersion(from: string): number[] {
    const dir = dirname(require.resolve(from));
    const pkg = require.resolve("multer/package.json", { paths: [dir] });
    const { version } = JSON.parse(readFileSync(pkg, "utf8")) as { version: string };
    return version.split(".").map(Number);
  }

  function atLeast(actual: number[], floor: number[]): boolean {
    for (let i = 0; i < floor.length; i++) {
      if ((actual[i] ?? 0) > floor[i]) return true;
      if ((actual[i] ?? 0) < floor[i]) return false;
    }
    return true;
  }

  it("resolves >= 2.3.0 from @nestjs/platform-express, not just at the top level", () => {
    // The top-level copy was never the problem; this is the one FileInterceptor uses.
    expect(atLeast(resolvedMulterVersion("@nestjs/platform-express"), MINIMUM)).toBe(true);
  });

  it("resolves >= 2.3.0 at the top level too, so both copies agree", () => {
    expect(atLeast(resolvedMulterVersion("multer"), MINIMUM)).toBe(true);
  });

  it("keeps the override that makes the first case true", () => {
    // platform-express pins "2.2.0" exactly, so nothing but an override reaches it.
    const pkg = JSON.parse(src("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(pkg.pnpm?.overrides?.multer).toBeDefined();
  });

  it("proves the comparator can fail, so the three cases above mean something", () => {
    // Without this, a comparator bug that returns true for everything would make
    // the whole block vacuous and indistinguishable from a genuine pass.
    expect(atLeast([2, 2, 0], MINIMUM)).toBe(false);
    expect(atLeast([1, 9, 9], MINIMUM)).toBe(false);
    expect(atLeast([2, 3, 0], MINIMUM)).toBe(true);
    expect(atLeast([3, 0, 0], MINIMUM)).toBe(true);
  });
});
