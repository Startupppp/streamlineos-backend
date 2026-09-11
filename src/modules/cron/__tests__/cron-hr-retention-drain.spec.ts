import { CronHrRetentionService } from "../cron-hr-retention.service";
import type { StorageService } from "../../storage/storage.service";
import type { Db } from "../../../db/drizzle.module";
import {
  attendance,
  documentAuditLogs,
  documents,
  hrAuditLogs,
  hrCases,
  hrPeople,
  hrRetentionPolicies,
  onboardingDocuments,
} from "../../../db/schema";

jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../../common/tenant/for-each-org";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

const ORG = "org-hr-drain";
const BATCH_SIZE = 200;

// ─── One batch per tick reported a clean sweep having deleted 0.1% of the backlog ──
//
// MECHANISM: sweepEmployees/sweepCases/sweepAttendance each ran a single
// `LIMIT BATCH_SIZE` statement, and sweepDocuments selected one page of `documents`
// and one of `onboarding_documents`, per policy per tick. Processed rows stop matching,
// so it resumed across ticks — but nothing said "rows still eligible", so a backlog
// above 200 was indistinguishable from an empty table. This is the DOCUMENT retention
// path the PRD criterion names.
//
// Every fixture below is LARGER than BATCH_SIZE. A fixture of 200 or fewer cannot tell
// a drain from a single statement: one call returns everything and the assertion passes
// either way.

interface Counter {
  calls: number;
}

/** A table that yields `total` rows, at most `BATCH_SIZE` per statement. */
function pager(total: number) {
  let remaining = total;
  const counter: Counter = { calls: 0 };
  return {
    counter,
    take(): { id: number }[] {
      counter.calls++;
      const n = Math.min(remaining, BATCH_SIZE);
      remaining -= n;
      return Array.from({ length: n }, (_, i) => ({ id: remaining + i + 1 }));
    },
    /** A table whose pages never shrink: the stall a non-progressing action produces. */
    takeAlwaysFull(): { id: number }[] {
      counter.calls++;
      return Array.from({ length: BATCH_SIZE }, (_, i) => ({ id: i + 1 }));
    },
  };
}

interface HarnessOptions {
  policy: { recordType: string; action: string };
  employees?: number;
  cases?: number;
  attendanceRows?: number;
  genericDocs?: number;
  onboardingDocs?: number;
  /** Rows come back full for ever — the shape a policy with no matching action produces. */
  stallingDocs?: boolean;
}

function makeHarness(options: HarnessOptions) {
  const employeePager = pager(options.employees ?? 0);
  const casePager = pager(options.cases ?? 0);
  const attendancePager = pager(options.attendanceRows ?? 0);
  const genericSelect = pager(options.genericDocs ?? 0);
  const genericWrite = pager(options.genericDocs ?? 0);
  const onboardingSelect = pager(options.onboardingDocs ?? 0);
  const onboardingWrite = pager(options.onboardingDocs ?? 0);
  const audits: Record<string, unknown>[] = [];

  let lastGenericPage = 0;
  let lastOnboardingPage = 0;

  const selectChain = () => {
    let table: unknown = null;
    const resolve = (): unknown[] => {
      if (table === hrRetentionPolicies)
        return [
          {
            id: 1,
            orgId: ORG,
            recordType: options.policy.recordType,
            action: options.policy.action,
            retentionMonths: 6,
            active: true,
          },
        ];
      if (table === documents) {
        const page = options.stallingDocs ? genericSelect.takeAlwaysFull() : genericSelect.take();
        lastGenericPage = page.length;
        return page;
      }
      if (table === onboardingDocuments) {
        const page = options.stallingDocs
          ? onboardingSelect.takeAlwaysFull()
          : onboardingSelect.take();
        lastOnboardingPage = page.length;
        return page;
      }
      if (table === documentAuditLogs) return [];
      return [];
    };
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(resolve()),
      then: (ok: (v: unknown) => unknown, err?: (r: unknown) => unknown) =>
        Promise.resolve(resolve()).then(ok, err),
    };
    return chain;
  };

  const writeChain = (table: unknown, isDelete: boolean) => {
    const resolve = (): unknown[] => {
      if (table === hrPeople) return employeePager.take();
      if (table === hrCases) return casePager.take();
      if (table === attendance) return attendancePager.take();
      if (table === documents) {
        if (options.stallingDocs) return [];
        genericWrite.counter.calls++;
        return Array.from({ length: lastGenericPage }, (_, i) => ({ id: i + 1 }));
      }
      if (table === onboardingDocuments) {
        if (options.stallingDocs) return [];
        // A delete removes the page; the redact pass then finds nothing left to redact.
        if (!isDelete) return [];
        onboardingWrite.counter.calls++;
        return Array.from({ length: lastOnboardingPage }, (_, i) => ({ id: i + 1 }));
      }
      return [];
    };
    const chain = {
      set: () => chain,
      where: () => chain,
      returning: () => Promise.resolve(resolve()),
      then: (ok: (v: unknown) => unknown, err?: (r: unknown) => unknown) =>
        Promise.resolve(resolve()).then(ok, err),
    };
    return chain;
  };

  const tx = {
    select: jest.fn(() => selectChain()),
    update: jest.fn((table: unknown) => writeChain(table, false)),
    delete: jest.fn((table: unknown) => writeChain(table, true)),
    insert: jest.fn((table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === hrAuditLogs) audits.push(row);
        return Promise.resolve(undefined);
      },
    })),
  };

  mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
    await fn(tx as never, ORG);
    return { organizations: 1, succeeded: 1, failed: 0 };
  });

  const storage = { deleteFileIfPresent: jest.fn().mockResolvedValue(undefined) };
  const service = new CronHrRetentionService({} as Db, storage as unknown as StorageService);

  return {
    service,
    audits,
    employeeCalls: employeePager.counter,
    caseCalls: casePager.counter,
    attendanceCalls: attendancePager.counter,
    genericSelectCalls: genericSelect.counter,
    onboardingSelectCalls: onboardingSelect.counter,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("CronHrRetentionService — the row sweeps drain instead of taking one batch", () => {
  it("soft-deletes all 437 eligible employees across three statements, not the first 200", async () => {
    const h = makeHarness({ policy: { recordType: "employee", action: "delete" }, employees: 437 });

    const result = await h.service.sweep();

    expect(h.employeeCalls.calls).toBe(3);
    expect(result.employeeSoftDeleted).toBe(437);
    expect(result.truncated).toBe(false);
  });

  it("soft-deletes all 437 eligible cases across three statements", async () => {
    const h = makeHarness({ policy: { recordType: "case", action: "delete" }, cases: 437 });

    const result = await h.service.sweep();

    expect(h.caseCalls.calls).toBe(3);
    expect(result.caseSoftDeleted).toBe(437);
  });

  it("deletes all 1037 eligible attendance rows across six statements", async () => {
    const h = makeHarness({
      policy: { recordType: "attendance", action: "delete" },
      attendanceRows: 1037,
    });

    const result = await h.service.sweep();

    expect(h.attendanceCalls.calls).toBe(6);
    expect(result.attendanceDeleted).toBe(1037);
  });

  it("reports truncated and stops at the batch cap rather than holding the transaction open", async () => {
    const h = makeHarness({
      policy: { recordType: "employee", action: "delete" },
      employees: BATCH_SIZE * 250,
    });

    const result = await h.service.sweep();

    expect(h.employeeCalls.calls).toBe(100);
    expect(result.employeeSoftDeleted).toBe(BATCH_SIZE * 100);
    expect(result.truncated).toBe(true);
  });

  it("carries truncated into the hr_audit_logs payload, so it is durable and not just a log line", async () => {
    const h = makeHarness({
      policy: { recordType: "employee", action: "delete" },
      employees: BATCH_SIZE * 250,
    });

    await h.service.sweep();

    const after = h.audits[0].after as Record<string, unknown>;
    expect(after.truncated).toBe(true);
    expect(after.count).toBe(BATCH_SIZE * 100);
  });
});

describe("CronHrRetentionService — the document path, which the PRD criterion names", () => {
  it("drains 437 generic documents across three selects instead of one page per tick", async () => {
    const h = makeHarness({
      policy: { recordType: "document", action: "delete" },
      genericDocs: 437,
    });

    const result = await h.service.sweep();

    expect(h.genericSelectCalls.calls).toBe(3);
    expect(result.documentsDeleted).toBe(437);
    expect(result.truncated).toBe(false);
  });

  it("drains 437 onboarding documents too — both tables, not one page of each", async () => {
    const h = makeHarness({
      policy: { recordType: "document", action: "delete" },
      onboardingDocs: 437,
    });

    const result = await h.service.sweep();

    expect(h.onboardingSelectCalls.calls).toBe(3);
    expect(result.documentsDeleted).toBe(437);
  });

  it("records how many rows it scanned alongside how many it processed", async () => {
    const h = makeHarness({
      policy: { recordType: "document", action: "delete" },
      genericDocs: 437,
    });

    await h.service.sweep();

    const after = h.audits[0].after as Record<string, unknown>;
    expect(after.scanned).toBe(437);
    expect(after.count).toBe(437);
  });
});

describe("CronHrRetentionService — the no-progress guard", () => {
  it("stops after one batch when a policy's action processes nothing, instead of spinning for ever", async () => {
    const h = makeHarness({
      policy: { recordType: "document", action: "archive" },
      genericDocs: 10_000,
      onboardingDocs: 10_000,
      stallingDocs: true,
    });

    const result = await h.service.sweep();

    // A full page came back and nothing was processed: that is a stall, not progress.
    expect(h.genericSelectCalls.calls).toBe(1);
    expect(h.onboardingSelectCalls.calls).toBe(1);
    expect(result.documentsDeleted).toBe(0);
    expect(result.onboardingDocumentsRedacted).toBe(0);
  });

  it("states the stall in the audit payload — scanned 400, processed 0", async () => {
    const h = makeHarness({
      policy: { recordType: "document", action: "archive" },
      genericDocs: 10_000,
      onboardingDocs: 10_000,
      stallingDocs: true,
    });

    await h.service.sweep();

    const after = h.audits[0].after as Record<string, unknown>;
    expect(after.scanned).toBe(BATCH_SIZE * 2);
    expect(after.count).toBe(0);
  });
});

describe("CronHrRetentionService — per-tenant failures reach the result", () => {
  it("surfaces organizationsFailed rather than reporting a clean sweep", async () => {
    const h = makeHarness({ policy: { recordType: "employee", action: "delete" }, employees: 5 });
    mockedForEachOrg.mockResolvedValue({ organizations: 3, succeeded: 2, failed: 1 });

    const result = await h.service.sweep();

    expect(result.organizations).toBe(3);
    expect(result.organizationsFailed).toBe(1);
  });
});
