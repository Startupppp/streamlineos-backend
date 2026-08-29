import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PayrollComponentsService } from "./components.service";
import { PayrollTemplatesService } from "./templates.service";

type FindFirst = jest.Mock<Promise<undefined>, [{ where?: unknown }]>;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];

  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function actor(orgId: string): Parameters<PayrollComponentsService["update"]>[0] {
  return { orgId, userId: "attacker" } as Parameters<PayrollComponentsService["update"]>[0];
}

describe("Payroll setup — cross-tenant isolation", () => {
  it("PayrollComponentsService rejects a component from another organization before mutation", async () => {
    const findFirst: FindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { salaryComponents: { findFirst } },
    };
    const service = new PayrollComponentsService(db as unknown as Db);

    await expect(service.update(actor("org-attacker"), 41, {})).rejects.toThrow(
      NotFoundException,
    );

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(sqlValues(findFirst.mock.calls[0]?.[0]?.where)).toContain("org-attacker");
  });

  it("PayrollTemplatesService does not expose a custom template from another organization", async () => {
    const findFirst: FindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { payrollTemplates: { findFirst } },
    };
    const service = new PayrollTemplatesService(db as unknown as Db);

    await expect(service.getById("org-attacker", 52)).rejects.toThrow(NotFoundException);

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(sqlValues(findFirst.mock.calls[0]?.[0]?.where)).toContain("org-attacker");
  });
});
