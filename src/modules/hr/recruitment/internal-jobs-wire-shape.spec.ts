import { RecruitmentJobsService } from "./recruitment-jobs.service";
import type { Db } from "../../../db/drizzle.module";

/**
 * The internal-openings payload, asserted on what the read path RETURNS.
 *
 * `hooks/api/hr/recruitment/internal-jobs.ts:29` reads through `apiClient.get<InternalJob[]>`, a
 * cast. `InternalJob` declares `department` and `departmentId`; the service shipped the Drizzle
 * relation under its schema name, `orgDepartment` / `orgDepartmentId`, so `job.department` was
 * `undefined` on every row and the badge guarded by `{job.department && ...}` never rendered.
 *
 * The read is an explicit left join rather than a relational `with:`, because on this schema
 * Drizzle does not type `with:` for `jobPostings` at all — `db.query.jobPostings.findMany({ with:
 * { orgDepartment } })` compiles and contributes NOTHING to the result type, which is a second way
 * this defect class hides from a typecheck.
 */

const ORG = "org-1";
const DEPARTMENT_ID = "c0ffee00-0000-4000-8000-000000000001";

/** A joined row exactly as the select hands it back. */
function joinedJobRow(departmentId: string | null, id: number) {
  return {
    id,
    title: "Staff Engineer",
    departmentId,
    departmentName: departmentId === null ? null : "Engineering",
    location: "Remote",
    type: "FULL_TIME",
    experience: "5+ years",
    description: null,
    requirements: null,
    openings: 2,
    applicationDeadline: null,
    createdAt: new Date("2026-09-01T10:00:00Z"),
  };
}

/** The pre-fix relational row: the department arrives under its schema name, two keys the client never reads. */
function nestedJobRow(departmentId: string | null, id: number) {
  const { departmentId: _dropped, departmentName: _also, ...rest } = joinedJobRow(departmentId, id);
  return {
    ...rest,
    orgDepartmentId: departmentId,
    orgDepartment: departmentId === null ? null : { id: departmentId, name: "Engineering" },
  };
}

function makeDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "leftJoin", "where"]) chain[method] = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain as unknown as Db;
}

function build(db: Db) {
  return new RecruitmentJobsService(db, {} as never, {} as never);
}

describe("internal openings — the department under the name the client reads", () => {
  it("GET /hr/recruitment/internal-jobs emits department and departmentId", async () => {
    const jobs = await build(makeDb([joinedJobRow(DEPARTMENT_ID, 1)])).listInternalJobs(ORG);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).not.toHaveProperty("orgDepartment");
    expect(jobs[0]).not.toHaveProperty("orgDepartmentId");
    expect(jobs[0]).not.toHaveProperty("departmentName");
    expect(jobs[0]?.department).toEqual({ id: DEPARTMENT_ID, name: "Engineering" });
    expect(jobs[0]?.departmentId).toBe(DEPARTMENT_ID);
  });

  it("emits exactly the keys InternalJob declares, and nothing else", async () => {
    const jobs = await build(makeDb([joinedJobRow(DEPARTMENT_ID, 1)])).listInternalJobs(ORG);

    expect(Object.keys(jobs[0] ?? {}).sort()).toEqual([
      "applicationDeadline",
      "createdAt",
      "department",
      "departmentId",
      "description",
      "experience",
      "id",
      "location",
      "openings",
      "requirements",
      "title",
      "type",
    ]);
  });

  it("carries a department id that is a uuid string, which is what org_units actually holds", async () => {
    const jobs = await build(makeDb([joinedJobRow(DEPARTMENT_ID, 1)])).listInternalJobs(ORG);

    expect(typeof jobs[0]?.department?.id).toBe("string");
  });

  it("a job with no department flattens to nulls, never to a missing key", async () => {
    const jobs = await build(makeDb([joinedJobRow(null, 2)])).listInternalJobs(ORG);

    expect(jobs[0]?.department).toBeNull();
    expect(jobs[0]?.departmentId).toBeNull();
    expect(jobs[0] && "department" in jobs[0]).toBe(true);
  });
});

/**
 * The consumer guard, run against the real payload: `internal-jobs-client.tsx:109` renders the
 * badge only when `job.department` is truthy.
 */
describe("internal openings — the department badge against the real payload", () => {
  interface FlatJob {
    department?: { id: string; name: string } | null;
  }

  const badge = (job: FlatJob | undefined) => (job?.department ? job.department.name : null);

  it("BITE: the pre-fix payload renders no badge on any card", () => {
    const preFix = nestedJobRow(DEPARTMENT_ID, 1) as unknown as FlatJob;
    expect(badge(preFix)).toBeNull();
  });

  it("the served payload renders the department name", async () => {
    const jobs = await build(makeDb([joinedJobRow(DEPARTMENT_ID, 1)])).listInternalJobs(ORG);

    expect(badge(jobs[0])).toBe("Engineering");
  });
});
