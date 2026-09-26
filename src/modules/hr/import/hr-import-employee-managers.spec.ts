import { resolveImportFallbacks } from "./hr-import-employee-managers";
import type { RowValidationResult } from "./schemas/entity-row-schemas";

const row = (rowNumber: number, payload: Record<string, unknown>): RowValidationResult => ({ rowNumber, status: "valid", payload, error: null });
const resolver = { resolveMany: jest.fn().mockResolvedValue([]) };
const actor = { orgId: "org-1", system: "spec" };

describe("resolveImportFallbacks — an existing employee's top-level row at preview", () => {
  it("makes a top-level reason alone a row error, and accepts it with clearPrimaryManager or on a new hire", async () => {
    const result = await resolveImportFallbacks(resolver, actor, "employees", [
      row(1, { email: "a@example.com", resolvedExistingEmployee: true, topLevelRoleReason: "Board" }),
      row(2, { email: "b@example.com", resolvedExistingEmployee: true, topLevelRoleReason: "Board", clearPrimaryManager: true }),
      row(3, { email: "c@example.com", topLevelRoleReason: "Founder" }),
    ]);
    expect(result.errors.map((entry) => [entry.rowNumber, entry.error])).toEqual([[1, expect.stringContaining("clearPrimaryManager")]]);
    expect(result.valid.map((entry) => entry.rowNumber)).toEqual([2, 3]);
  });
});
