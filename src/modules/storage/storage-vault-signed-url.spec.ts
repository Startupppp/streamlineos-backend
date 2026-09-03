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
  readonly documentType: string | null;
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
  documentType: "PASSPORT",
};

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
});
