/**
 * V-012a, at the attendance write itself.
 *
 * The person lookup in `commitAttendance` filtered on the org and
 * `hr_people.deleted_at IS NULL` and stopped there. "Exists in this org" is not
 * "works here": a pending hire whose invitation has never been opened matched,
 * so attendance could be imported for somebody who has not joined — and that
 * row then counts towards the attendance rate and the payable days payroll
 * reads.
 *
 * The predicate is `acceptedEmployee()` from `../shared/employee-acceptance`,
 * imported rather than rewritten, so there is one definition of the split. The
 * refusal has its own message because "not found" and "not accepted yet" need
 * different actions from the operator.
 */
import type { Db } from "../../../db/drizzle.module";
import { attendance, hrPeople } from "../../../db/schema";
import { HrImportCommitService } from "./hr-import-commit.service";
import { importContext, stubAdmission, stubPersonEmployment } from "./import-commit-test-harness";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const ORG = "org-attendance";

/** Rows keyed by the table a query selects FROM; the insert is recorded. */
function fakeTx(rows: Map<unknown, unknown[]>) {
  const inserted: Array<Record<string, unknown>> = [];
  const select = () => {
    let table: unknown;
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(rows.get(table) ?? []).then(resolve),
    };
    for (const method of ["where", "orderBy", "limit", "innerJoin", "leftJoin"]) {
      builder[method] = () => builder;
    }
    builder["from"] = (t: unknown) => {
      table = t;
      return builder;
    };
    return builder;
  };
  const tx = {
    select,
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: () => Promise.resolve([{ id: 55 }]) };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  };
  return { tx: tx as unknown as Tx, inserted };
}

const service = () => new HrImportCommitService(stubAdmission(), stubPersonEmployment());
const row = { employeeEmail: "pending@example.test", date: "2026-01-05", checkIn: "09:30" };

describe("HR attendance import commit", () => {
  it("refuses attendance for someone who has not accepted their invitation", async () => {
    const { tx, inserted } = fakeTx(
      new Map<unknown, unknown[]>([
        [hrPeople, [{ userId: "user-pending", accepted: false }]],
        [attendance, []],
      ]),
    );

    await expect(
      service().commitRow(tx, importContext(ORG), "attendance", row),
    ).rejects.toThrow(/has not accepted their invitation yet/);
    // Distinct from the "no such person" refusal, which needs a different fix
    // from the operator.
    await expect(
      service().commitRow(tx, importContext(ORG), "attendance", row),
    ).rejects.not.toThrow(/No user found/);
    expect(inserted).toHaveLength(0);
  });

  it("still writes attendance for an accepted employee", async () => {
    // Positive control (BE-141): the refusal above must be the acceptance flag,
    // not the double refusing everything.
    const { tx, inserted } = fakeTx(
      new Map<unknown, unknown[]>([
        [hrPeople, [{ userId: "user-accepted", accepted: true }]],
        [attendance, []],
      ]),
    );

    const ref = await service().commitRow(tx, importContext(ORG), "attendance", {
      ...row,
      employeeEmail: "accepted@example.test",
    });
    expect(ref.table).toBe("attendance");
    expect(inserted[0]?.["userId"]).toBe("user-accepted");
  });

  it("reads a wall-clock cell in the organisation's zone, not a hardcoded one", async () => {
    const { tx, inserted } = fakeTx(
      new Map<unknown, unknown[]>([
        [hrPeople, [{ userId: "user-accepted", accepted: true }]],
        [attendance, []],
      ]),
    );

    await service().commitRow(
      tx,
      { ...importContext(ORG), timeZone: "America/Los_Angeles" },
      "attendance",
      { ...row, employeeEmail: "accepted@example.test", checkIn: "09:30" },
    );
    // 09:30 on 2026-01-05 in Los Angeles is 17:30Z. Under the old hardcoded
    // Asia/Kolkata it was 04:00Z — eight hours off, every row.
    expect((inserted[0]?.["checkIn"] as Date).toISOString()).toBe("2026-01-05T17:30:00.000Z");
  });
});
