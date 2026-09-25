/**
 * The preview used to be database-blind (V-010e, V-011c/e, V-012c).
 *
 * `validateRows` checks shapes only, so every reference a file names — a leave
 * type, an employee email, a department, a manager — was first looked at during
 * the commit. QA's four-row leave-balance sheet previewed as "3 valid, 1 error"
 * and then wrote one row: the unknown leave type and the unknown employee were
 * both reported VALID to the operator and only failed after they had pressed
 * Commit.
 *
 * These assertions are about which rows come back as errors and what the errors
 * say. The wording is deliberately the same wording the commit throws, so
 * preview and commit agree instead of contradicting each other.
 */
import type { Db } from "../../../db/drizzle.module";
import { hrPeople, hrEmployments, leaveTypes, orgUnits } from "../../../db/schema";
import { resolveRowReferences, stripResolvedKeys } from "./hr-import-preflight";
import type { RowValidationResult } from "./schemas/entity-row-schemas";

/** Rows keyed by the table a query selects FROM. */
function fakeDb(tables: Map<unknown, unknown[]>) {
  const select = () => {
    let table: unknown;
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(tables.get(table) ?? []).then(resolve),
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
  return { select } as unknown as Db;
}

function row(rowNumber: number, payload: Record<string, unknown>): RowValidationResult {
  return { rowNumber, payload, status: "valid", error: null };
}

const ORG = "org-preflight";

describe("HR import preflight — reference resolution at preview", () => {
  it("reports an unknown leave type and an unknown employee as row errors, not as valid", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        // Only one of the two people named by the file exists in this org.
        [hrPeople, [{ email: "known@example.test", userId: "user-known", accepted: true }]],
        [leaveTypes, [{ id: 4, name: "Annual Leave" }]],
      ]),
    );

    const result = await resolveRowReferences(db, ORG, "leave_balances", [
      row(1, { employeeEmail: "known@example.test", leaveTypeName: "Annual Leave", balance: 12, year: 2026 }),
      row(2, { employeeEmail: "known@example.test", leaveTypeName: "Sabbatical", balance: 5, year: 2026 }),
      row(3, { employeeEmail: "ghost@example.test", leaveTypeName: "Annual Leave", balance: 3, year: 2026 }),
    ]);

    expect(result.valid.map((r) => r.rowNumber)).toEqual([1]);
    expect(result.errors.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(result.errors[0]?.error).toBe("Leave type 'Sabbatical' not found");
    expect(result.errors[1]?.error).toBe("No user found for email ghost@example.test");
    // The resolved id is stored on the payload so the commit stops re-reading it.
    expect(result.valid[0]?.payload["resolvedUserId"]).toBe("user-known");
    expect(result.valid[0]?.payload["resolvedLeaveTypeId"]).toBe(4);
  });

  it("refuses attendance for someone who has not accepted their invitation", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [hrPeople, [{ email: "pending@example.test", userId: "user-pending", accepted: false }]],
      ]),
    );

    const result = await resolveRowReferences(db, ORG, "attendance", [
      row(1, { employeeEmail: "pending@example.test", date: "2026-01-05" }),
    ]);

    expect(result.valid).toHaveLength(0);
    // Distinct from "No user found": the operator's next action is different.
    expect(result.errors[0]?.error).toContain("has not accepted their invitation yet");
    expect(result.errors[0]?.error).not.toContain("No user found");
  });

  it("resolves a department name to an org unit and fails a name no unit carries", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [orgUnits, [{ key: "engineering", id: "unit-eng" }]],
        [hrPeople, []],
        [hrEmployments, []],
      ]),
    );

    const result = await resolveRowReferences(db, ORG, "employees", [
      row(1, { email: "a@example.test", departmentName: "Engineering" }),
      row(2, { email: "b@example.test", departmentName: "Astrophysics" }),
    ]);

    expect(result.valid[0]?.payload["resolvedDepartmentId"]).toBe("unit-eng");
    expect(result.errors[0]?.rowNumber).toBe(2);
    expect(result.errors[0]?.error).toContain('Department "Astrophysics" was not found');
  });

  it("fails a manager email that names nobody employed here", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [hrPeople, []],
        [hrEmployments, []],
        [orgUnits, []],
      ]),
    );

    const result = await resolveRowReferences(db, ORG, "employees", [
      row(1, { email: "new@example.test", managerEmail: "nobody@example.test" }),
    ]);

    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]?.error).toContain("is not an employee of this organization");
  });

  it("strips resolved-id keys off a raw row so a CSV column cannot supply one", () => {
    const stripped = stripResolvedKeys({
      employeeEmail: "a@example.test",
      resolvedUserId: "user-from-another-tenant",
      resolvedLeaveTypeId: 99,
    });
    expect(stripped["resolvedUserId"]).toBeUndefined();
    expect(stripped["resolvedLeaveTypeId"]).toBeUndefined();
    // Positive control: the real columns survive.
    expect(stripped["employeeEmail"]).toBe("a@example.test");
  });
});
