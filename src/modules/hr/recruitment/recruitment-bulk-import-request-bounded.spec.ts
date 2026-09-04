import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { RecruitmentCandidateOpsService } from "./recruitment-candidate-ops.service";
import type { Db } from "../../../db/drizzle.module";

/**
 * `POST /hr/recruitment/candidates/bulk-import` read the whole organisation to
 * answer a question about at most 500 rows.
 *
 * The dedupe probe was `db.query.candidates.findMany({ where: eq(orgId) })`
 * with no limit and no other predicate — every candidate the tenant has ever
 * held, pulled into memory to build a Set that is then asked only about the
 * emails in this request. It is the request-shaped read that must be bounded,
 * not the write: `candidates` carries no unique on (org_id, email), so the
 * `onConflictDoNothing()` on the insert below can never fire and this probe IS
 * the duplicate check — deleting it would start importing duplicates.
 *
 * It was carried in the unbounded-reads ledger as FALSE-POSITIVE with a note
 * that contradicted the verdict ("needs keyset migration"), so the gate counted
 * it as suppressed and stayed green. The last assertion here pins that entry:
 * re-suppressing the read instead of bounding it fails.
 */

const BACKEND = path.resolve(__dirname, "..", "..", "..", "..");
const dialect = new PgDialect();

interface Captured {
  readonly db: Db;
  readonly where: jest.Mock;
  readonly limit: jest.Mock;
  readonly findMany: jest.Mock;
  readonly insert: jest.Mock;
}

function capturingDb(existing: { email: string }[]): Captured {
  const limit = jest.fn().mockResolvedValue(existing);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const selectDistinct = jest.fn().mockReturnValue({ from });
  const findMany = jest.fn().mockResolvedValue(existing);
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });
  const db = {
    selectDistinct,
    insert,
    query: { candidates: { findMany } },
  } as unknown as Db;
  return { db, where, limit, findMany, insert };
}

const cache = { invalidateNamespace: jest.fn() };
const stub = <T,>() => ({}) as T;

function makeService(db: Db) {
  return new RecruitmentCandidateOpsService(
    db,
    stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[1]>(),
    cache as unknown as ConstructorParameters<typeof RecruitmentCandidateOpsService>[2],
    stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[3]>(),
    stub<ConstructorParameters<typeof RecruitmentCandidateOpsService>[4]>(),
  );
}

function rows(emails: readonly string[]) {
  return emails.map((email, index) => ({
    firstName: `First${index}`,
    lastName: `Last${index}`,
    email,
  }));
}

describe("recruitment bulk import — the dedupe probe is bounded by the request", () => {
  const ORG = "org-1";

  afterEach(() => jest.clearAllMocks());

  it("never issues the org-wide findMany the old probe used", async () => {
    const captured = capturingDb([]);
    await makeService(captured.db).bulkImport(ORG, {
      rows: rows(["a@x.com", "b@x.com"]),
    } as Parameters<RecruitmentCandidateOpsService["bulkImport"]>[1]);

    expect(captured.findMany).not.toHaveBeenCalled();
  });

  it("binds the probe to this request's emails and caps it at their count", async () => {
    const captured = capturingDb([]);
    await makeService(captured.db).bulkImport(ORG, {
      rows: rows(["Alice@X.com", "bob@x.com", "alice@x.com"]),
    } as Parameters<RecruitmentCandidateOpsService["bulkImport"]>[1]);

    expect(captured.where).toHaveBeenCalledTimes(1);
    const compiled = dialect.sqlToQuery(
      captured.where.mock.calls[0]?.[0] as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(compiled.sql).toMatch(/"candidates"\."org_id"\s*=\s*\$\d+/);
    expect(compiled.sql).toMatch(/lower\("candidates"\."email"\)\s+in\s+\(/);
    expect(compiled.params).toEqual([ORG, "alice@x.com", "bob@x.com"]);

    // Two distinct emails in a three-row request, so the cap is two, not three
    // and not the size of the organisation.
    expect(captured.limit).toHaveBeenCalledWith(2);
  });

  it("still skips a row whose email exists in a different letter case", async () => {
    const captured = capturingDb([{ email: "mixedcase@x.com" }]);
    const result = await makeService(captured.db).bulkImport(ORG, {
      rows: rows(["MixedCase@X.com", "fresh@x.com"]),
    } as Parameters<RecruitmentCandidateOpsService["bulkImport"]>[1]);

    expect(result.skipped).toBe(1);
    expect(result.created).toBe(1);
    const inserted = captured.insert.mock.results[0]?.value as {
      values: jest.Mock;
    };
    expect(inserted.values.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ email: "fresh@x.com" }),
    ]);
  });

  it("is no longer suppressed as a FALSE-POSITIVE in the unbounded-reads ledger", () => {
    const ledger: {
      unbounded?: Record<string, { verdict?: string }>;
    } = JSON.parse(
      fs.readFileSync(
        path.join(BACKEND, "src/scripts/baselines/unbounded-reads-classification.json"),
        "utf8",
      ),
    );
    const entry = ledger.unbounded?.["/hr/recruitment/recruitment-candidate-ops.service.ts"];
    expect(entry).toBeDefined();
    expect(entry?.verdict).toBe("BOUNDED");
  });
});
