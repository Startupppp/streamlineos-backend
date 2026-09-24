import { StorageVaultController } from "./storage-vault.controller";
import type { StorageService } from "./storage.service";
import type { AccessService } from "../access/access.service";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const PUBLIC_BASE = "https://pub-891e5f8831c54f9295d7dda0eac7ed65.r2.dev";

interface VaultRow {
  readonly id: number;
  readonly candidateId: number;
  readonly orgId: string;
  readonly filename: string;
  readonly s3Key: string;
  readonly fileUrl: string;
  readonly fileType: string;
  readonly fileSize: number;
  readonly documentType: string | null;
  readonly avResult: "PENDING" | "CLEAN" | "INFECTED";
  readonly expiresAt: string | null;
  readonly uploadedBy: string;
  readonly createdAt: Date;
}

function makeDb(row: VaultRow | undefined): Db {
  const db = {
    query: { candidateDocumentsVault: { findFirst: jest.fn(async () => row) } },
    insert: jest.fn(() => ({ values: jest.fn(async () => undefined) })),
  };
  return db as unknown as Db;
}

/**
 * The real parser, not a stub: the whole point of this behaviour is that a
 * legacy stored PUBLIC URL is turned back into a key and presigned, and a stub
 * that returns whatever it is given would pass while the controller handed the
 * public URL straight back.
 */
function realGetFileKeyFromUrl(url: string): string {
  const value = url.trim();
  if (!/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith(`${PUBLIC_BASE}/`)) return "";
  return decodeURIComponent(value.slice(PUBLIC_BASE.length + 1).split(/[?#]/, 1)[0] ?? "");
}

function makeStorage(overrides: Partial<StorageService> = {}): StorageService {
  const storage = {
    isConfigured: () => true,
    getFileKeyFromUrl: realGetFileKeyFromUrl,
    getFileUrl: jest.fn(async (_orgId: string, key: string) => `https://signed.example/${key}?sig=x`),
    ...overrides,
  };
  return storage as unknown as StorageService;
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn(async () => new Set(["hr:documents:manage"])),
  } as unknown as AccessService;
}

const USER: CurrentUserContext = {
  userId: "u1",
  orgId: "org-1",
  isOrgOwner: true,
} as unknown as CurrentUserContext;

const BASE_ROW: VaultRow = {
  id: 7,
  candidateId: 3,
  orgId: "org-1",
  filename: "passport.pdf",
  s3Key: "org-1/candidate-vault/passport.pdf",
  fileUrl: "org-1/candidate-vault/passport.pdf",
  fileType: "application/pdf",
  fileSize: 1024,
  documentType: "PASSPORT",
  avResult: "CLEAN",
  expiresAt: null,
  uploadedBy: "u1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/**
 * The row carried `av_result` and the controller returned it to the caller and
 * otherwise ignored it — so a file a scanner had flagged still produced a
 * signed URL, and the only thing standing between a recruiter and the malware
 * was whether the UI happened to read the field.
 */
describe("StorageVaultController — an infected object has no authorised reader", () => {
  it("refuses to sign a URL for a document the scanner flagged", async () => {
    const storage = makeStorage();
    const controller = new StorageVaultController(
      makeDb({ ...BASE_ROW, avResult: "INFECTED" }),
      storage,
      makeAccess(),
    );

    await expect(controller.download(3, 7, USER)).rejects.toMatchObject({ status: 422 });
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  /**
   * PENDING is NOT refused. It is the normal state on a deployment with no
   * scanner configured, and refusing it would make every résumé unreadable
   * there; the response carries `avResult` so the screen can warn instead.
   */
  it("still serves an unscanned document, and says it is unscanned", async () => {
    const controller = new StorageVaultController(
      makeDb({ ...BASE_ROW, avResult: "PENDING" }),
      makeStorage(),
      makeAccess(),
    );

    const result = await controller.download(3, 7, USER);
    expect(result.avResult).toBe("PENDING");
    expect(result.signedUrl).not.toBeNull();
  });
});

describe("StorageVaultController — the vault never hands back a stored permanent URL", () => {
  it("presigns the object key", async () => {
    const storage = makeStorage();
    const controller = new StorageVaultController(makeDb(BASE_ROW), storage, makeAccess());

    const result = await controller.download(3, 7, USER);

    expect(result.signedUrl).toBe(
      "https://signed.example/org-1/candidate-vault/passport.pdf?sig=x",
    );
  });

  it("presigns a legacy row whose only address is a permanent PUBLIC URL, instead of returning it", async () => {
    const storage = makeStorage();
    const controller = new StorageVaultController(
      makeDb({
        ...BASE_ROW,
        s3Key: "",
        fileUrl: `${PUBLIC_BASE}/org-1/candidate-vault/my%20passport.pdf`,
      }),
      storage,
      makeAccess(),
    );

    const result = await controller.download(3, 7, USER);

    expect(result.signedUrl).toBe(
      "https://signed.example/org-1/candidate-vault/my passport.pdf?sig=x",
    );
    expect(result.signedUrl).not.toContain(PUBLIC_BASE);
  });

  it("returns null rather than the stored value when presigning fails", async () => {
    const storage = makeStorage({
      getFileUrl: jest.fn(async () => {
        throw new Error("provider unavailable");
      }) as unknown as StorageService["getFileUrl"],
    });
    const controller = new StorageVaultController(
      makeDb({ ...BASE_ROW, fileUrl: `${PUBLIC_BASE}/org-1/candidate-vault/passport.pdf` }),
      storage,
      makeAccess(),
    );

    const result = await controller.download(3, 7, USER);

    expect(result.signedUrl).toBeNull();
  });

  it("returns null rather than the stored value when object storage is not configured", async () => {
    const storage = makeStorage({ isConfigured: () => false });
    const controller = new StorageVaultController(
      makeDb({ ...BASE_ROW, fileUrl: `${PUBLIC_BASE}/org-1/candidate-vault/passport.pdf` }),
      storage,
      makeAccess(),
    );

    const result = await controller.download(3, 7, USER);

    expect(result.signedUrl).toBeNull();
  });

  /**
   * The presign was only ever half the fix. The handler used to return
   * `{ ...doc, signedUrl }`, so the permanent address it had just replaced rode
   * back out beside its replacement, and so did the raw object key. Asserting
   * on `signedUrl` alone cannot see that — the assertion has to be that the
   * response does not CONTAIN the stored value anywhere.
   */
  it("does not return the stored permanent URL, or the object key, beside the signed one", async () => {
    const controller = new StorageVaultController(
      makeDb({
        ...BASE_ROW,
        s3Key: "org-1/candidate-vault/passport.pdf",
        fileUrl: `${PUBLIC_BASE}/org-1/candidate-vault/passport.pdf`,
      }),
      makeStorage(),
      makeAccess(),
    );

    const result = await controller.download(3, 7, USER);

    expect(JSON.stringify(result)).not.toContain(PUBLIC_BASE);
    expect(Object.keys(result).sort()).toEqual([
      "avResult",
      "candidateId",
      "createdAt",
      "documentType",
      "expiresAt",
      "fileSize",
      "fileType",
      "filename",
      "id",
      "signedUrl",
    ]);
    expect(result.filename).toBe("passport.pdf");
    expect(result.signedUrl).toBe(
      "https://signed.example/org-1/candidate-vault/passport.pdf?sig=x",
    );
  });
});
