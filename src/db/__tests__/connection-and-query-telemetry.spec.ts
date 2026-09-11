import { poolTelemetry, withPoolBorrow, runOutsidePoolBorrow } from "../pool-telemetry";
import { QueryTelemetryTracker } from "../query-telemetry";
import {
  classifyContention,
  fingerprintQuery,
  normalizeQueryShape,
  rowsReturnedOf,
} from "../query-fingerprint";
import { getBorrowScope, noteStatementEnd, noteStatementStart } from "../borrow-scope";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settled<T>(value: T): { then: PromiseLike<T>["then"] } {
  return { then: (onOk, onErr) => Promise.resolve(value).then(onOk, onErr) };
}

function rejected(reason: unknown): { then: PromiseLike<never>["then"] } {
  return { then: (onOk, onErr) => Promise.reject(reason).then(onOk, onErr) };
}

describe("§5.1 box 8 — connection hold time and idle-in-transaction are measured", () => {
  beforeEach(() => poolTelemetry.reset());

  it("records how long the connection was held, not only how long it was waited for", async () => {
    await withPoolBorrow(async (borrow) => {
      borrow.acquired();
      await sleep(30);
    });

    const snapshot = poolTelemetry.snapshot();
    expect(snapshot.borrows).toBe(1);
    expect(snapshot.maxHeldMs).toBeGreaterThanOrEqual(25);
    expect(snapshot.averageHeldMs).toBeGreaterThanOrEqual(25);
  });

  it("attributes the gap between two statements to idle-in-transaction", async () => {
    await withPoolBorrow(async (borrow) => {
      borrow.acquired();
      noteStatementStart();
      noteStatementEnd();
      await sleep(30);
      noteStatementStart();
      noteStatementEnd();
    });

    const snapshot = poolTelemetry.snapshot();
    expect(snapshot.statementsPerBorrowMax).toBe(2);
    expect(snapshot.maxIdleInTransactionMs).toBeGreaterThanOrEqual(25);
  });

  it("reports a borrow that ran back-to-back statements as not idle", async () => {
    await withPoolBorrow(async (borrow) => {
      borrow.acquired();
      for (let index = 0; index < 5; index++) {
        noteStatementStart();
        noteStatementEnd();
      }
    });

    const snapshot = poolTelemetry.snapshot();
    expect(snapshot.statementsPerBorrowMax).toBe(5);
    expect(snapshot.idleInTransactionBorrows).toBe(0);
  });

  it("does not attribute work done outside the borrow to the borrow", async () => {
    await withPoolBorrow(async (borrow) => {
      borrow.acquired();
      await runOutsidePoolBorrow(async () => {
        expect(getBorrowScope()).toBeUndefined();
        noteStatementStart();
        noteStatementEnd();
      });
    });

    expect(poolTelemetry.snapshot().statementsPerBorrowMax).toBe(0);
  });
});

describe("§5.1 box 9 — fingerprints, call counts, rows and lock waits without bind values", () => {
  it("normalises every literal and placeholder out of the shape", () => {
    // The table name is inert to this assertion — only the literals are under
    // test — so it is deliberately NOT one of the four identity tables the Party
    // migration is retiring. `legacy-reader-ratchet.spec.ts` scans every file
    // under `src/` for raw SQL naming those tables, and it cannot skip string
    // literals without going blind to the `db.execute(sql`...`)` reads it exists
    // to catch. A fixture naming one is indistinguishable from a real read, and
    // would put this file on the migration's debt register having read nothing.
    const shape = normalizeQueryShape(
      "select id from hr_people where org_id = 'org-secret' and email = $1 and age > 42 -- note",
    );
    expect(shape).toBe("select id from hr_people where org_id = ? and email = ? and age > ?");
    expect(shape).not.toContain("org-secret");
    expect(shape).not.toContain("42");
  });

  it("collapses an IN list so a 1-id and a 500-id call share one fingerprint", () => {
    const one = fingerprintQuery("select id from t where id in ($1)");
    const many = fingerprintQuery(
      `select id from t where id in (${Array.from({ length: 500 }, (_u, i) => `$${i + 1}`).join(", ")})`,
    );
    expect(many.id).toBe(one.id);
  });

  it("counts calls, rows returned and duration per fingerprint", async () => {
    const tracker = new QueryTelemetryTracker();
    for (let index = 0; index < 7; index++)
      await tracker.observe(settled([{ id: index }, { id: index + 100 }]), "select id from t where id = $1");

    const [stat] = tracker.topFingerprints();
    expect(stat?.calls).toBe(7);
    expect(stat?.rowsReturned).toBe(14);
    expect(tracker.snapshot().rowsReturned).toBe(14);
    expect(tracker.snapshot()["db.query.execute"].count).toBe(7);
  });

  it("keeps no bind value anywhere in a fingerprint it exposes", async () => {
    const tracker = new QueryTelemetryTracker();
    await tracker.observe(
      settled([]),
      "select * from hr_people where pan = 'ABCDE1234F' and salary = 950000",
    );
    const shapes = tracker.topFingerprints().map((stat) => stat.shape);
    expect(shapes.join(" ")).not.toContain("ABCDE1234F");
    expect(shapes.join(" ")).not.toContain("950000");
    expect(shapes[0]).toContain("hr_people");
  });

  it("classifies lock timeout, deadlock and statement timeout separately", async () => {
    const tracker = new QueryTelemetryTracker();
    for (const code of ["55P03", "40P01", "57014"]) {
      const error = Object.assign(new Error("db"), { code });
      await expect(
        Promise.resolve(tracker.observe(rejected(error), "update t set x = $1")),
      ).rejects.toThrow("db");
    }

    const snapshot = tracker.snapshot();
    expect(snapshot.lockWaits).toBe(1);
    expect(snapshot.deadlocks).toBe(1);
    expect(snapshot.timeouts).toBe(1);
    expect(tracker.topFingerprints()[0]?.errors).toBe(3);
  });

  it("classifies a plain error as neither a lock wait nor a timeout", () => {
    expect(classifyContention(Object.assign(new Error("x"), { code: "23505" }))).toBeNull();
    expect(classifyContention(null)).toBeNull();
  });

  it("reads a row count from an array, a rows property or a count property", () => {
    expect(rowsReturnedOf([1, 2, 3])).toBe(3);
    expect(rowsReturnedOf({ rows: [1, 2] })).toBe(2);
    expect(rowsReturnedOf({ count: 9 })).toBe(9);
    expect(rowsReturnedOf(undefined)).toBe(0);
  });

  it("does not fingerprint the GUC setup statement as application query traffic", async () => {
    const tracker = new QueryTelemetryTracker();
    await tracker.observe(settled([]), "SELECT set_config('app.organization_id', $1, true)");
    expect(tracker.snapshot()["db.guc.setup"].count).toBe(1);
    expect(tracker.topFingerprints()).toHaveLength(0);
  });
});
