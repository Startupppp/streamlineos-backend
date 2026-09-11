import { NotFoundException } from "@nestjs/common";
import { KbSourcesService } from "./kb-sources.service";

function makeDb(rows: Record<string, unknown>[]): unknown {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return { update };
}

function makeStorage(deleteFileFn = jest.fn().mockResolvedValue(undefined)) {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    deleteFile: deleteFileFn,
  };
}

function makeIndexing() {
  return { removeSourceChunks: jest.fn().mockResolvedValue(undefined) };
}

/*
 * A non-empty KB bucket, deliberately. With "" the override resolves to undefined
 * and requireBucket falls through to the default bucket, so the delete and the
 * upload agree by accident and the assertion below would pass on a service that
 * dropped the override entirely.
 */
const KB_BUCKET = "kb-files";

function makeConfig() {
  return { R2_KB_BUCKET_NAME: KB_BUCKET, R2_KB_PUBLIC_URL: "" };
}

function makeService(
  rows: Record<string, unknown>[],
  deleteFileFn = jest.fn().mockResolvedValue(undefined),
) {
  return new KbSourcesService(
    makeDb(rows) as never,
    makeStorage(deleteFileFn) as never,
    makeIndexing() as never,
    makeConfig() as never,
    {} as never,
  );
}

describe("KbSourcesService.remove — storage cleanup", () => {
  it("calls storage.deleteFile with the KB bucket the upload used, not the default one", async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const row = { kind: "file", fileKey: "kb-sources/org-1/doc.pdf" };
    const svc = makeService([row], deleteFile);

    await svc.remove("org-1", 42);

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(
      "org-1",
      "kb-sources/org-1/doc.pdf",
      KB_BUCKET,
    );
  });

  it("does NOT call storage.deleteFile for a note-kind source", async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const row = { kind: "note", fileKey: null };
    const svc = makeService([row], deleteFile);

    await svc.remove("org-1", 7);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("does NOT call storage.deleteFile for a file-kind source with null fileKey", async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const row = { kind: "file", fileKey: null };
    const svc = makeService([row], deleteFile);

    await svc.remove("org-1", 9);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("swallows a storage failure so the caller still gets { success: true }", async () => {
    const deleteFile = jest.fn().mockRejectedValue(new Error("R2 unreachable"));
    const row = { kind: "file", fileKey: "kb-sources/org-1/doc.pdf" };
    const svc = makeService([row], deleteFile);

    const result = await svc.remove("org-1", 42);

    expect(result).toEqual({ success: true });
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundException when the source is not found", async () => {
    const svc = makeService([]);

    await expect(svc.remove("org-1", 99)).rejects.toThrow(NotFoundException);
  });
});
