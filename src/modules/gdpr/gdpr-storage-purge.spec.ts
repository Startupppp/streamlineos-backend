import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { GdprStoragePurgeService } from "./gdpr-storage-purge.service";
import { StorageService } from "../storage/storage.service";
import type { SubjectFileKey } from "../storage/storage-key-catalog";
import * as storageKeyCatalog from "../storage/storage-key-catalog";

const ORG_A = "org-aaa";
const ORG_B = "org-bbb";
const USER_HELD = "user-held";
const USER_FREE = "user-free";
const ACTOR = "user-actor";

const SAMPLE_KEY: SubjectFileKey = {
  key: "documents/file.pdf",
  table: "public.hr_documents",
  column: "file_key",
  source: "user-fk",
};

const FAIL_KEY: SubjectFileKey = {
  key: "documents/will-fail.pdf",
  table: "public.hr_documents",
  column: "file_key",
  source: "user-fk",
};

function makeDb(legalHoldRows: unknown[], auditInsertRows: unknown[] = []) {
  const selectChain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(legalHoldRows),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);

  const insertChain = {
    values: jest.fn().mockResolvedValue(auditInsertRows),
  };

  return {
    select: jest.fn().mockReturnValue(selectChain),
    insert: jest.fn().mockReturnValue(insertChain),
    execute: jest.fn().mockResolvedValue([]),
  };
}

async function buildService(db: unknown, storage: Partial<StorageService> = {}) {
  const module = await Test.createTestingModule({
    providers: [
      GdprStoragePurgeService,
      { provide: DRIZZLE, useValue: db },
      { provide: StorageService, useValue: storage },
    ],
  }).compile();
  return module.get(GdprStoragePurgeService);
}

describe("GdprStoragePurgeService — Item C: physical storage purge", () => {
  describe("dry-run default", () => {
    it("returns manifest without calling deleteFile", async () => {
      const db = makeDb([]);
      const deleteFile = jest.fn();
      const svc = await buildService(db, { deleteFile });

      jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
        { table: "public.hr_documents", column: "file_key" },
      ]);
      jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

      const result = await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.deleted).toHaveLength(0);
      expect(result.manifest).toHaveLength(1);
      expect(deleteFile).not.toHaveBeenCalled();
    });
  });

  describe("legal hold enforcement — Item D", () => {
    it("(bite proof) blocks purge when subject has an active legal hold, returns blocked=true", async () => {
      const db = makeDb([{ id: 1 }]);
      const deleteFile = jest.fn();
      const svc = await buildService(db, { deleteFile });

      const result = await svc.purgeSubjectStorage(USER_HELD, [ORG_A], ACTOR, ORG_A, { dryRun: false });

      expect(result.blocked).toBe(true);
      expect(result.blockReason).toBe("active-legal-hold");
      expect(result.deleted).toHaveLength(0);
      expect(deleteFile).not.toHaveBeenCalled();
    });

    it("permits purge for unheld subject while held subject remains blocked", async () => {
      const heldDb = makeDb([{ id: 1 }]);
      const freeDb = makeDb([]);
      const deleteFile = jest.fn().mockResolvedValue(undefined);

      jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
        { table: "public.hr_documents", column: "file_key" },
      ]);
      jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

      const heldSvc = await buildService(heldDb, { deleteFile });
      const freeSvc = await buildService(freeDb, { deleteFile });

      const heldResult = await heldSvc.purgeSubjectStorage(USER_HELD, [ORG_A], ACTOR, ORG_A, { dryRun: false });
      const freeResult = await freeSvc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });

      expect(heldResult.blocked).toBe(true);
      expect(freeResult.blocked).toBe(false);
      expect(freeResult.deleted).toHaveLength(1);
    });

    it("legal hold check includes the org scope — cross-org hold does not block different org", async () => {
      const db = makeDb([]);
      const deleteFile = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([]);
      jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([]);

      const svc = await buildService(db, { deleteFile });
      const result = await svc.purgeSubjectStorage(USER_HELD, ["org-other"], ACTOR, "org-other", { dryRun: false });

      expect(result.blocked).toBe(false);
    });
  });

  describe("partial failure — Item C (the confirmed defect fix)", () => {
    it("(bite proof) a failed deleteFile call stays in failed[], NOT in deleted[]", async () => {
      const db = makeDb([]);
      const deleteFile = jest.fn().mockImplementation((_orgId: string, key: string) => {
        if (key === FAIL_KEY.key) return Promise.reject(new Error("AccessDenied"));
        return Promise.resolve();
      });

      jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
        { table: "public.hr_documents", column: "file_key" },
      ]);
      jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([
        SAMPLE_KEY,
        FAIL_KEY,
      ]);

      const svc = await buildService(db, { deleteFile });
      const result = await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });

      expect(result.deleted).toContain(SAMPLE_KEY.key);
      expect(result.deleted).not.toContain(FAIL_KEY.key);
      expect(result.failed.map((f) => f.key)).toContain(FAIL_KEY.key);
      expect(result.failed).toHaveLength(1);
      expect(result.deleted).toHaveLength(1);
    });

    it("records the failure reason in the failed entry", async () => {
      const db = makeDb([]);
      const deleteFile = jest.fn().mockRejectedValue(new Error("NetworkTimeout"));

      jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
        { table: "public.hr_documents", column: "file_key" },
      ]);
      jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

      const svc = await buildService(db, { deleteFile });
      const result = await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });

      expect(result.failed[0]?.reason).toBe("NetworkTimeout");
      expect(result.deleted).toHaveLength(0);
    });
  });

  describe("placement isolation — Item C org-id fix", () => {
    it("(bite proof) purge calls deleteFile with primaryOrgId, not the first element of orgIds", async () => {
      const db = makeDb([]);
      const deleteFile = jest.fn().mockResolvedValue(undefined);

      jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
        { table: "public.hr_documents", column: "file_key" },
      ]);
      jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

      const svc = await buildService(db, { deleteFile });
      await svc.purgeSubjectStorage(
        USER_FREE,
        [ORG_B, ORG_A],
        ACTOR,
        ORG_A,
        { dryRun: false },
      );

      expect(deleteFile).toHaveBeenCalledWith(ORG_A, SAMPLE_KEY.key);
      expect(deleteFile).not.toHaveBeenCalledWith(ORG_B, SAMPLE_KEY.key);
    });
  });
});

describe("GdprStoragePurgeService — Item D: erasure audit log does not leak PII", () => {
  it("records audit with keyCount but without name, email or phone in metadata", async () => {
    const db = makeDb([]);
    const insertChain = { values: jest.fn().mockResolvedValue([]) };
    db.insert = jest.fn().mockReturnValue(insertChain);
    const deleteFile = jest.fn().mockResolvedValue(undefined);

    jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
      { table: "public.hr_documents", column: "file_key" },
    ]);
    jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

    const svc = await buildService(db, { deleteFile });
    await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });

    expect(db.insert).toHaveBeenCalled();
    const insertValues = insertChain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    const metadata = insertValues?.metadata as Record<string, unknown> | undefined;

    expect(metadata).toBeDefined();
    expect(metadata).toHaveProperty("keyCount");
    expect(Object.keys(metadata ?? {})).not.toContain("email");
    expect(Object.keys(metadata ?? {})).not.toContain("name");
    expect(Object.keys(metadata ?? {})).not.toContain("phone");
    expect(Object.keys(metadata ?? {})).not.toContain("subjectEmail");
    expect(Object.keys(metadata ?? {})).not.toContain("subjectName");
  });

  it("records failedCount in metadata alongside keyCount", async () => {
    const db = makeDb([]);
    const insertChain = { values: jest.fn().mockResolvedValue([]) };
    db.insert = jest.fn().mockReturnValue(insertChain);
    const deleteFile = jest.fn().mockRejectedValue(new Error("StorageError"));

    jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
      { table: "public.hr_documents", column: "file_key" },
    ]);
    jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

    const svc = await buildService(db, { deleteFile });
    await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });

    const insertValues = insertChain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    const metadata = insertValues?.metadata as Record<string, unknown> | undefined;
    expect(metadata).toHaveProperty("failedCount", 1);
    expect(metadata).toHaveProperty("keyCount", 0);
  });

  it("records the actor (non-subject) userId, never the subject's PII", async () => {
    const db = makeDb([]);
    const insertChain = { values: jest.fn().mockResolvedValue([]) };
    db.insert = jest.fn().mockReturnValue(insertChain);
    const deleteFile = jest.fn().mockResolvedValue(undefined);

    jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([]);
    jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([]);

    const svc = await buildService(db, { deleteFile });
    await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });

    const insertValues = insertChain.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertValues?.userId).toBe(ACTOR);
    expect(insertValues?.userId).not.toBe(USER_FREE);
  });
});

describe("GdprStoragePurgeService.buildManifest — dry-run inventory", () => {
  it("returns blocked manifest without touching storage when hold is active", async () => {
    const db = makeDb([{ id: 1 }]);
    const svc = await buildService(db);
    const manifest = await svc.buildManifest(USER_HELD, [ORG_A]);
    expect(manifest.blocked).toBe(true);
    expect(manifest.keys).toHaveLength(0);
  });

  it("returns key list for unheld subject", async () => {
    const db = makeDb([]);
    jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
      { table: "public.hr_documents", column: "file_key" },
    ]);
    jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

    const svc = await buildService(db);
    const manifest = await svc.buildManifest(USER_FREE, [ORG_A]);
    expect(manifest.blocked).toBe(false);
    expect(manifest.keys).toHaveLength(1);
    expect(manifest.keys[0]?.key).toBe(SAMPLE_KEY.key);
  });
});

describe("GdprStoragePurgeService — Item A: idempotency of repeated purge", () => {
  it("(bite proof) second purge of same subject does not throw — S3 DELETE of a missing key is 204", async () => {
    const db = makeDb([]);
    const deleteFile = jest.fn().mockResolvedValue(undefined);

    jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
      { table: "public.hr_documents", column: "file_key" },
    ]);
    jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

    const svc = await buildService(db, { deleteFile });

    const first = await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });
    expect(first.deleted).toHaveLength(1);
    expect(first.blocked).toBe(false);

    const second = await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });
    expect(second.deleted).toHaveLength(1);
    expect(second.blocked).toBe(false);

    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it("reports what was deleted — deleted and manifest are both present in the result", async () => {
    const db = makeDb([]);
    const deleteFile = jest.fn().mockResolvedValue(undefined);

    jest.spyOn(storageKeyCatalog, "enumerateFileKeyColumns").mockResolvedValue([
      { table: "public.hr_documents", column: "file_key" },
    ]);
    jest.spyOn(storageKeyCatalog, "collectSubjectFileKeysWithLegalHold").mockResolvedValue([SAMPLE_KEY]);

    const svc = await buildService(db, { deleteFile });
    const result = await svc.purgeSubjectStorage(USER_FREE, [ORG_A], ACTOR, ORG_A, { dryRun: false });

    expect(result).toHaveProperty("deleted");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("manifest");
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toBe(SAMPLE_KEY.key);
    expect(result.manifest).toHaveLength(1);
    expect(result.manifest[0]?.key).toBe(SAMPLE_KEY.key);
  });
});
