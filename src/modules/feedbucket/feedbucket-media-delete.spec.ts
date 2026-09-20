import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { FeedbucketMediaStorage } from "./feedbucket-submissions.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(txSpy),
  ),
}));

jest.mock("../../common/tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn(() => false),
}));

interface TxSpy {
  delete: jest.Mock;
  update: jest.Mock;
  deletedFrom: unknown[];
  updatedWith: Record<string, unknown>[];
}

const txSpy: TxSpy = {
  delete: jest.fn(),
  update: jest.fn(),
  deletedFrom: [],
  updatedWith: [],
};

function resetTx() {
  txSpy.deletedFrom = [];
  txSpy.updatedWith = [];
  txSpy.delete = jest.fn((table: unknown) => {
    txSpy.deletedFrom.push(table);
    return { where: jest.fn().mockResolvedValue(undefined) };
  });
  txSpy.update = jest.fn(() => ({
    set: jest.fn((patch: Record<string, unknown>) => {
      txSpy.updatedWith.push(patch);
      return { where: jest.fn().mockResolvedValue(undefined) };
    }),
  }));
}

const ORG = "org-owner";

interface SubmissionShape {
  id: number;
  orgId: string;
  screenshotUrl: string | null;
  screenshotKey: string | null;
  deletedAt: null;
}

function makeDb(submission: SubmissionShape, attachmentRows: unknown[][]): Db {
  const findFirst = jest.fn().mockResolvedValue(submission);
  let selectCall = 0;
  const select = jest.fn(() => {
    const rows = attachmentRows[selectCall] ?? [];
    selectCall += 1;
    const terminal = Promise.resolve(rows);
    const where = jest.fn(() =>
      Object.assign(terminal, {
        orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue(rows) })),
      }),
    );
    return { from: jest.fn(() => ({ where })) };
  });
  return {
    query: { feedbucketSubmissions: { findFirst } },
    select,
  } as unknown as Db;
}

describe("FeedbucketSubmissionsService.deleteMedia", () => {
  let storage: jest.Mocked<FeedbucketMediaStorage>;

  beforeEach(() => {
    resetTx();
    storage = { deleteFileIfPresent: jest.fn().mockResolvedValue(true) };
  });

  it("purges the stored object only after the row change commits, so a rolled-back delete cannot destroy a referenced file", async () => {
    const submission: SubmissionShape = {
      id: 7,
      orgId: ORG,
      screenshotUrl: "feedbucket/w1/screenshots/shot.png",
      screenshotKey: null,
      deletedAt: null,
    };
    const db = makeDb(submission, [[], [{ id: 31, fileUrl: "feedbucket/w1/screenshots/shot.png", fileKey: null }]]);
    const service = new FeedbucketSubmissionsService(db, storage);

    await service.deleteMedia(ORG, 7, "screenshot");

    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith(
      ORG,
      "feedbucket/w1/screenshots/shot.png",
    );
  });

  it("clears both screenshot columns so the detail read stops pointing at a deleted object", async () => {
    const submission: SubmissionShape = {
      id: 7,
      orgId: ORG,
      screenshotUrl: "keyA",
      screenshotKey: "keyA",
      deletedAt: null,
    };
    const db = makeDb(submission, [[], [{ id: 31, fileUrl: "keyA", fileKey: "keyA" }]]);
    const service = new FeedbucketSubmissionsService(db, storage);

    await service.deleteMedia(ORG, 7, "screenshot");

    expect(txSpy.updatedWith[0]).toMatchObject({ screenshotUrl: null, screenshotKey: null });
  });

  it("leaves the screenshot column untouched when deleting a recording, because the two live in different places", async () => {
    const submission: SubmissionShape = {
      id: 7,
      orgId: ORG,
      screenshotUrl: "shot.png",
      screenshotKey: "shot.png",
      deletedAt: null,
    };
    const db = makeDb(submission, [[], [{ id: 44, fileUrl: "rec.webm", fileKey: null }]]);
    const service = new FeedbucketSubmissionsService(db, storage);

    await service.deleteMedia(ORG, 7, "recording");

    expect(txSpy.updatedWith).toEqual([]);
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith(ORG, "rec.webm");
    expect(storage.deleteFileIfPresent).not.toHaveBeenCalledWith(ORG, "shot.png");
  });

  it("throws NotFound rather than reporting success when the submission has no media of that kind", async () => {
    const submission: SubmissionShape = {
      id: 7,
      orgId: ORG,
      screenshotUrl: null,
      screenshotKey: null,
      deletedAt: null,
    };
    const db = makeDb(submission, [[], []]);
    const service = new FeedbucketSubmissionsService(db, storage);

    await expect(service.deleteMedia(ORG, 7, "recording")).rejects.toThrow(NotFoundException);
    expect(storage.deleteFileIfPresent).not.toHaveBeenCalled();
  });

  it("refuses a submission owned by another org, because findOne scopes on orgId before any delete runs", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { feedbucketSubmissions: { findFirst } },
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({ orderBy: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })) })),
        })),
      })),
    } as unknown as Db;
    const service = new FeedbucketSubmissionsService(db, storage);

    await expect(service.deleteMedia("org-attacker", 7, "screenshot")).rejects.toThrow(
      NotFoundException,
    );
    expect(storage.deleteFileIfPresent).not.toHaveBeenCalled();
  });
});
