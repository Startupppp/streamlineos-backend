import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import type { Db } from "../../db/drizzle.module";
import { feedbucketSubmissions } from "../../db/schema";
import { orgBindings, sqlValues } from "../../test/tenant-recorder-sql";
import type { FeedbucketMediaStorage } from "./feedbucket-submissions.service";
import {
  FEEDBUCKET_MEDIA_ATTACHMENT_SCAN_CAP,
  FEEDBUCKET_MEDIA_PURGE_BATCH,
  FEEDBUCKET_MEDIA_PURGE_RUN_BUDGET,
  FEEDBUCKET_MEDIA_RETENTION_DAYS,
  FEEDBUCKET_MEDIA_RETENTION_SWEEP,
  FeedbucketMediaRetentionService,
} from "./feedbucket-media-retention.service";

jest.mock("../../common/tenant", () => ({ forEachOrg: jest.fn() }));

const forEachOrgMock = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

interface SubmissionRow {
  id: number;
  screenshotKey: string | null;
  screenshotUrl: string | null;
  deletedAt: Date | null;
  mediaPurgedAt: Date | null;
}

interface AttachmentRow {
  id: number;
  submissionId: number;
  fileKey: string | null;
  fileUrl: string | null;
}

interface OrgFixture {
  submissions: SubmissionRow[];
  attachments: AttachmentRow[];
}

interface RecordedSelect {
  where: unknown;
  limit: number | null;
}

interface TxRecorder {
  handle: TenantTx;
  selects: RecordedSelect[];
  updates: { patch: Record<string, unknown>; where: unknown }[];
}

const dialect = new PgDialect();

function render(where: unknown): { text: string; params: readonly unknown[] } {
  const query = dialect.sqlToQuery(where as unknown as SQL);
  return { text: query.sql, params: query.params };
}

/**
 * The cutoff the SERVICE bound, read back out of the statement it built. Nothing
 * in this file recomputes it, so a sweep that binds the wrong window fails the
 * boundary tests rather than dragging the double along with it.
 */
function boundCutoff(params: readonly unknown[]): Date | null {
  for (const param of params) {
    if (param instanceof Date) return param;
    if (typeof param === "string" && /^\d{4}-\d{2}-\d{2}/.test(param)) {
      const parsed = Date.parse(param);
      if (!Number.isNaN(parsed)) return new Date(parsed);
    }
  }
  return null;
}

/**
 * Answers a select from the fixture by applying only the predicates the
 * statement actually wrote. A sweep that forgets `deleted_at IS NOT NULL` gets
 * the live rows back, exactly as Postgres would hand them over.
 */
function visibleSubmissions(fixture: OrgFixture, where: unknown): SubmissionRow[] {
  const { text, params } = render(where);
  const cutoff = boundCutoff(params);
  return fixture.submissions.filter((row) => {
    if (/"deleted_at" is not null/i.test(text) && row.deletedAt === null) return false;
    if (/"media_purged_at" is null/i.test(text) && row.mediaPurgedAt !== null) return false;
    if (/"deleted_at" </.test(text)) {
      if (cutoff === null) return true;
      if (row.deletedAt === null || row.deletedAt.getTime() >= cutoff.getTime()) return false;
    }
    return true;
  });
}

function makeTx(fixture: OrgFixture): TxRecorder {
  const selects: RecordedSelect[] = [];
  const updates: { patch: Record<string, unknown>; where: unknown }[] = [];
  let selectIndex = 0;

  const select = jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn((where: unknown) => {
        const index = selectIndex;
        selectIndex += 1;
        const record: RecordedSelect = { where, limit: null };
        selects.push(record);
        const rows =
          index === 0
            ? visibleSubmissions(fixture, where)
            : fixture.attachments.filter((attachment) =>
                sqlValues(where).includes(attachment.submissionId),
              );
        return Object.assign(Promise.resolve(rows), {
          orderBy: jest.fn(() => ({
            limit: jest.fn((limit: number) => {
              record.limit = limit;
              return Promise.resolve(rows.slice(0, limit));
            }),
          })),
          limit: jest.fn((limit: number) => {
            record.limit = limit;
            return Promise.resolve(rows.slice(0, limit));
          }),
        });
      }),
    })),
  }));

  const update = jest.fn(() => ({
    set: jest.fn((patch: Record<string, unknown>) => ({
      where: jest.fn((where: unknown) => {
        updates.push({ patch, where });
        const ids = sqlValues(where).filter(
          (value): value is number => typeof value === "number",
        );
        const purgedAt = patch.mediaPurgedAt;
        for (const row of fixture.submissions)
          if (ids.includes(row.id) && purgedAt instanceof Date) row.mediaPurgedAt = purgedAt;
        return Promise.resolve(undefined);
      }),
    })),
  }));

  return {
    handle: { select, update } as unknown as TenantTx,
    selects,
    updates,
  };
}

interface Harness {
  service: FeedbucketMediaRetentionService;
  storage: jest.Mocked<FeedbucketMediaStorage>;
  txByOrg: Map<string, TxRecorder>;
  sweepNames: string[];
  visitedOrgs: string[];
  db: Db;
}

function rotateAfter(ids: string[], startAfterOrgId: string | null | undefined): string[] {
  if (!startAfterOrgId) return ids;
  const pivot = ids.findIndex((id) => id > startAfterOrgId);
  if (pivot <= 0) return ids;
  return [...ids.slice(pivot), ...ids.slice(0, pivot)];
}

function makeHarness(orgs: Record<string, OrgFixture>): Harness {
  const storage: jest.Mocked<FeedbucketMediaStorage> = {
    deleteFileIfPresent: jest.fn().mockResolvedValue(true),
  };
  const txByOrg = new Map<string, TxRecorder>();
  const sweepNames: string[] = [];
  const visitedOrgs: string[] = [];
  const db = { select: jest.fn(), update: jest.fn(), query: {} } as unknown as Db;

  forEachOrgMock.mockImplementation(async (_db, sweep, fn, _intent, options) => {
    sweepNames.push(sweep);
    let failed = 0;
    let visited = 0;
    for (const orgId of rotateAfter(Object.keys(orgs).sort(), options?.startAfterOrgId)) {
      if (options?.stopWhen?.()) break;
      visited += 1;
      visitedOrgs.push(orgId);
      const fixture = orgs[orgId];
      if (!fixture) continue;
      const tx = makeTx(fixture);
      txByOrg.set(orgId, tx);
      try {
        await fn(tx.handle, orgId);
      } catch {
        failed += 1;
      }
    }
    return { organizations: visited, succeeded: visited - failed, failed };
  });

  return {
    service: new FeedbucketMediaRetentionService(db, storage),
    storage,
    txByOrg,
    sweepNames,
    visitedOrgs,
    db,
  };
}

function submission(over: Partial<SubmissionRow> & { id: number }): SubmissionRow {
  return {
    screenshotKey: `feedbucket/shot-${over.id}.png`,
    screenshotUrl: null,
    deletedAt: daysAgo(31),
    mediaPurgedAt: null,
    ...over,
  };
}

function budgetedOrgs(): Record<string, OrgFixture> {
  const orgs: Record<string, OrgFixture> = {};
  let nextId = 1;
  for (const suffix of ["a", "b", "c", "d", "e", "f"]) {
    orgs[`org-${suffix}`] = {
      submissions: Array.from({ length: FEEDBUCKET_MEDIA_PURGE_BATCH }, () => {
        const id = nextId;
        nextId += 1;
        return submission({ id, screenshotKey: `k-${id}.png` });
      }),
      attachments: [],
    };
  }
  return orgs;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("FeedbucketMediaRetentionService — the 30-day window", () => {
  it("declares the window once, as a named exported constant, so no caller restates the number", () => {
    expect(FEEDBUCKET_MEDIA_RETENTION_DAYS).toBe(30);
  });

  it("purges a submission soft-deleted 31 days ago and leaves one soft-deleted 29 days ago alone", async () => {
    const harness = makeHarness({
      "org-a": {
        submissions: [
          submission({ id: 1, deletedAt: daysAgo(31), screenshotKey: "old.png" }),
          submission({ id: 2, deletedAt: daysAgo(29), screenshotKey: "recent.png" }),
        ],
        attachments: [],
      },
    });

    const result = await harness.service.sweep(NOW);

    expect(harness.storage.deleteFileIfPresent).toHaveBeenCalledWith("org-a", "old.png");
    expect(harness.storage.deleteFileIfPresent).not.toHaveBeenCalledWith("org-a", "recent.png");
    expect(result.submissionsPurged).toBe(1);
  });

  it("binds the cutoff as now minus the retention window, so the boundary is the constant and not a hard-coded date", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 1 })], attachments: [] },
    });

    await harness.service.sweep(NOW);

    const where = harness.txByOrg.get("org-a")?.selects[0]?.where;
    const cutoff = boundCutoff(render(where).params);
    expect(cutoff).not.toBeNull();
    expect(cutoff?.getTime()).toBe(NOW.getTime() - FEEDBUCKET_MEDIA_RETENTION_DAYS * DAY_MS);
  });
});

describe("FeedbucketMediaRetentionService — a live submission keeps its media", () => {
  it("never deletes the media of a submission that was never soft-deleted, however old it is", async () => {
    const harness = makeHarness({
      "org-a": {
        submissions: [
          submission({ id: 1, deletedAt: null, screenshotKey: "live.png" }),
          submission({ id: 2, deletedAt: daysAgo(400), screenshotKey: "dead.png" }),
        ],
        attachments: [],
      },
    });

    const result = await harness.service.sweep(NOW);

    expect(harness.storage.deleteFileIfPresent).not.toHaveBeenCalledWith("org-a", "live.png");
    expect(harness.storage.deleteFileIfPresent).toHaveBeenCalledWith("org-a", "dead.png");
    expect(result.submissionsPurged).toBe(1);
  });

  it("matches the partial index predicate so the scan is index-served rather than a table walk", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 1 })], attachments: [] },
    });

    await harness.service.sweep(NOW);

    const { text } = render(harness.txByOrg.get("org-a")?.selects[0]?.where);
    expect(text).toMatch(/"deleted_at" is not null/i);
    expect(text).toMatch(/"media_purged_at" is null/i);
    expect(text).toMatch(/"deleted_at" </);
  });
});

describe("FeedbucketMediaRetentionService — attachments as well as the screenshot", () => {
  it("deletes every attachment object alongside the submission screenshot", async () => {
    const harness = makeHarness({
      "org-a": {
        submissions: [submission({ id: 1, screenshotKey: "shot.png" })],
        attachments: [
          { id: 10, submissionId: 1, fileKey: "rec.webm", fileUrl: null },
          { id: 11, submissionId: 1, fileKey: null, fileUrl: "extra.png" },
        ],
      },
    });

    await harness.service.sweep(NOW);

    expect(harness.storage.deleteFileIfPresent).toHaveBeenCalledWith("org-a", "shot.png");
    expect(harness.storage.deleteFileIfPresent).toHaveBeenCalledWith("org-a", "rec.webm");
    expect(harness.storage.deleteFileIfPresent).toHaveBeenCalledWith("org-a", "extra.png");
  });

  it("falls back to the screenshot url when no key column was ever written", async () => {
    const harness = makeHarness({
      "org-a": {
        submissions: [
          submission({ id: 1, screenshotKey: null, screenshotUrl: "legacy/shot.png" }),
        ],
        attachments: [],
      },
    });

    await harness.service.sweep(NOW);

    expect(harness.storage.deleteFileIfPresent).toHaveBeenCalledWith("org-a", "legacy/shot.png");
  });

  it("retains the submission row for audit, marking it purged instead of deleting it", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 1 })], attachments: [] },
    });

    await harness.service.sweep(NOW);

    const tx = harness.txByOrg.get("org-a");
    expect(tx?.updates).toHaveLength(1);
    expect(tx?.updates[0]?.patch.mediaPurgedAt).toBeInstanceOf(Date);
  });
});

describe("FeedbucketMediaRetentionService — convergence", () => {
  it("does not re-purge on a second run, because the first run set media_purged_at", async () => {
    const fixture: OrgFixture = {
      submissions: [submission({ id: 1, screenshotKey: "once.png" })],
      attachments: [],
    };
    const harness = makeHarness({ "org-a": fixture });

    const first = await harness.service.sweep(NOW);
    harness.storage.deleteFileIfPresent.mockClear();
    const second = await harness.service.sweep(NOW);

    expect(first.submissionsPurged).toBe(1);
    expect(second.submissionsPurged).toBe(0);
    expect(harness.storage.deleteFileIfPresent).not.toHaveBeenCalled();
  });

  it("marks a submission purged even when the object was already gone, so an absent file still converges", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 1 })], attachments: [] },
    });
    harness.storage.deleteFileIfPresent.mockResolvedValue(false);

    const result = await harness.service.sweep(NOW);

    expect(result.submissionsPurged).toBe(1);
    expect(result.objectsDeleted).toBe(0);
    expect(harness.txByOrg.get("org-a")?.updates).toHaveLength(1);
  });
});

describe("FeedbucketMediaRetentionService — a failed storage delete", () => {
  it("leaves media_purged_at null for the submission whose object could not be deleted", async () => {
    const harness = makeHarness({
      "org-a": {
        submissions: [
          submission({ id: 1, screenshotKey: "good.png" }),
          submission({ id: 2, screenshotKey: "bad.png" }),
        ],
        attachments: [],
      },
    });
    harness.storage.deleteFileIfPresent.mockImplementation(async (_org, key) => {
      if (key === "bad.png") throw new Error("R2 refused the delete");
      return true;
    });

    await expect(harness.service.sweep(NOW)).rejects.toThrow(/feedbucket media/i);

    const fixtureIds = harness.txByOrg.get("org-a")?.updates[0]?.where;
    expect(sqlValues(fixtureIds)).toContain(1);
    expect(sqlValues(fixtureIds)).not.toContain(2);
  });

  it("surfaces the failure instead of returning a clean result, so a sweep failing every night is not silent", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 2, screenshotKey: "bad.png" })], attachments: [] },
    });
    harness.storage.deleteFileIfPresent.mockRejectedValue(new Error("R2 refused the delete"));

    await expect(harness.service.sweep(NOW)).rejects.toThrow(/feedbucket media/i);
  });

  it("still purges the submissions whose objects did delete, so one bad key cannot stall the backlog", async () => {
    const harness = makeHarness({
      "org-a": {
        submissions: [
          submission({ id: 1, screenshotKey: "good.png" }),
          submission({ id: 2, screenshotKey: "bad.png" }),
        ],
        attachments: [],
      },
    });
    harness.storage.deleteFileIfPresent.mockImplementation(async (_org, key) => {
      if (key === "bad.png") throw new Error("R2 refused the delete");
      return true;
    });

    await expect(harness.service.sweep(NOW)).rejects.toThrow(/feedbucket media/i);

    expect(harness.txByOrg.get("org-a")?.updates).toHaveLength(1);
    expect(harness.storage.deleteFileIfPresent).toHaveBeenCalledWith("org-a", "good.png");
  });
});

describe("FeedbucketMediaRetentionService — bounded and resumable", () => {
  it("caps the rows it claims per organisation per run at the declared batch size", async () => {
    const many = Array.from({ length: FEEDBUCKET_MEDIA_PURGE_BATCH + 25 }, (_, index) =>
      submission({ id: index + 1, screenshotKey: `k-${index + 1}.png` }),
    );
    const harness = makeHarness({ "org-a": { submissions: many, attachments: [] } });

    const result = await harness.service.sweep(NOW);

    expect(harness.txByOrg.get("org-a")?.selects[0]?.limit).toBe(FEEDBUCKET_MEDIA_PURGE_BATCH);
    expect(result.submissionsPurged).toBe(FEEDBUCKET_MEDIA_PURGE_BATCH);
    expect(result.truncated).toBe(true);
  });

  it("leaves the overflow for the next run, which then finds it and drains it", async () => {
    const many = Array.from({ length: FEEDBUCKET_MEDIA_PURGE_BATCH + 25 }, (_, index) =>
      submission({ id: index + 1, screenshotKey: `k-${index + 1}.png` }),
    );
    const harness = makeHarness({ "org-a": { submissions: many, attachments: [] } });

    await harness.service.sweep(NOW);
    const second = await harness.service.sweep(NOW);

    expect(second.submissionsPurged).toBe(25);
    expect(second.truncated).toBe(false);
  });

  it("leaves a submission whose attachments overflowed the scan cap unpurged, rather than marking it purged with objects still stored", async () => {
    const overflow: AttachmentRow[] = Array.from(
      { length: FEEDBUCKET_MEDIA_ATTACHMENT_SCAN_CAP + 10 },
      (_, index) => ({
        id: index + 1,
        submissionId: index < FEEDBUCKET_MEDIA_ATTACHMENT_SCAN_CAP - 1 ? 1 : 2,
        fileKey: `a-${index + 1}.png`,
        fileUrl: null,
      }),
    );
    const harness = makeHarness({
      "org-a": {
        submissions: [
          submission({ id: 1, deletedAt: daysAgo(40), screenshotKey: "one.png" }),
          submission({ id: 2, deletedAt: daysAgo(35), screenshotKey: "two.png" }),
        ],
        attachments: overflow,
      },
    });

    const result = await harness.service.sweep(NOW);

    expect(result.truncated).toBe(true);
    expect(result.submissionsPurged).toBe(1);
    expect(harness.storage.deleteFileIfPresent).toHaveBeenCalledWith("org-a", "one.png");
    expect(harness.storage.deleteFileIfPresent).not.toHaveBeenCalledWith("org-a", "two.png");
  });

  it("stops opening transactions once the run budget is spent, instead of walking every remaining tenant", async () => {
    const harness = makeHarness(budgetedOrgs());

    const result = await harness.service.sweep(NOW);

    expect(result.submissionsPurged).toBe(FEEDBUCKET_MEDIA_PURGE_RUN_BUDGET);
    expect(result.truncated).toBe(true);
    expect(harness.visitedOrgs).not.toContain("org-f");
  });

  it("resumes after the organisation the budget ran out on, so a large tenant cannot starve the ones behind it", async () => {
    const harness = makeHarness(budgetedOrgs());

    await harness.service.sweep(NOW);
    const firstPass = [...harness.visitedOrgs];
    harness.visitedOrgs.length = 0;
    const second = await harness.service.sweep(NOW);

    expect(firstPass[0]).toBe("org-a");
    expect(harness.visitedOrgs[0]).toBe("org-f");
    expect(second.submissionsPurged).toBe(FEEDBUCKET_MEDIA_PURGE_BATCH);
  });

  it("reports truncated false when the backlog fitted inside one run", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 1 })], attachments: [] },
    });

    const result = await harness.service.sweep(NOW);

    expect(result.truncated).toBe(false);
  });
});

describe("FeedbucketMediaRetentionService — tenant iteration", () => {
  it("iterates organisations with forEachOrg rather than assuming an ambient tenant context", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 1 })], attachments: [] },
      "org-b": { submissions: [submission({ id: 2 })], attachments: [] },
    });

    const result = await harness.service.sweep(NOW);

    expect(forEachOrgMock).toHaveBeenCalledTimes(1);
    expect(harness.sweepNames).toEqual([FEEDBUCKET_MEDIA_RETENTION_SWEEP]);
    expect(harness.visitedOrgs).toEqual(["org-a", "org-b"]);
    expect(result.organizations).toBe(2);
  });

  it("runs every statement on the per-organisation transaction, never on the tenant-less handle", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 1 })], attachments: [] },
    });

    await harness.service.sweep(NOW);

    expect(harness.db.select).not.toHaveBeenCalled();
    expect(harness.db.update).not.toHaveBeenCalled();
    expect(harness.txByOrg.get("org-a")?.selects.length).toBeGreaterThan(0);
  });

  it("scopes each organisation's read to its own org id, so one tenant's sweep cannot claim another's rows", async () => {
    const harness = makeHarness({
      "org-a": { submissions: [submission({ id: 1 })], attachments: [] },
      "org-b": { submissions: [submission({ id: 2 })], attachments: [] },
    });

    await harness.service.sweep(NOW);

    expect(
      orgBindings(harness.txByOrg.get("org-a")?.selects[0]?.where, feedbucketSubmissions.orgId),
    ).toEqual(["org-a"]);
    expect(
      orgBindings(harness.txByOrg.get("org-b")?.selects[0]?.where, feedbucketSubmissions.orgId),
    ).toEqual(["org-b"]);
  });

  it("scopes the media_purged_at write to the same org id as the read that found the rows", async () => {
    const harness = makeHarness({
      "org-b": { submissions: [submission({ id: 2 })], attachments: [] },
    });

    await harness.service.sweep(NOW);

    expect(
      orgBindings(harness.txByOrg.get("org-b")?.updates[0]?.where, feedbucketSubmissions.orgId),
    ).toEqual(["org-b"]);
  });
});
