import { BadRequestException, ConflictException } from "@nestjs/common";
import { LeavePoliciesService } from "../leave-policies.service";
import { LeaveTypesService } from "../leave-types.service";

function createDb(typeRows: { id: number }[]) {
  const insert = jest.fn();
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(typeRows),
        }),
      }),
    }),
    insert,
  };
  insert.mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 99 }]),
    }),
  });
  return { db, insert };
}

const body = {
  leaveTypeId: 1,
  name: "Sick Leave",
  accrualType: "ANNUAL",
  accrualRate: "6",
  effectiveFrom: "2026-07-01",
};

describe("LeavePoliciesService leave-type org scoping", () => {
  it("rejects a leave type that does not belong to the organization", async () => {
    const { db, insert } = createDb([]);
    const service = new LeavePoliciesService(db as never);

    await expect(service.create("org-1", body as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates the policy when the leave type exists in the organization", async () => {
    const { db, insert } = createDb([{ id: 1 }]);
    const service = new LeavePoliciesService(db as never);

    const result = await service.create("org-1", body as never);
    expect(result).toEqual({ id: 99 });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("LeaveTypesService.create", () => {
  function createTypeDb(existing: { id: number } | undefined) {
    const returning = jest.fn().mockResolvedValue([
      { id: 5, name: "Sick Leave", daysPerYear: 12, carryForward: false },
    ]);
    return {
      query: { leaveTypes: { findFirst: jest.fn().mockResolvedValue(existing) } },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning }),
      }),
    };
  }

  it("rejects a duplicate name within the organization", async () => {
    const db = createTypeDb({ id: 3 });
    const service = new LeaveTypesService(db as never);
    await expect(
      service.create("org-1", { name: "Sick Leave", daysPerYear: 12 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("creates an org-scoped leave type and trims the name", async () => {
    const db = createTypeDb(undefined);
    const service = new LeaveTypesService(db as never);
    const created = await service.create("org-1", {
      name: "  Sick Leave  ",
      daysPerYear: 12,
    });
    expect(created).toMatchObject({ id: 5, name: "Sick Leave" });
  });
});

describe("LeaveTypesService management", () => {

  it("seeds the standard set idempotently via onConflictDoNothing", async () => {
    const returning = jest.fn().mockResolvedValue([
      { id: 1, name: "Casual Leave" },
      { id: 2, name: "Sick Leave" },
    ]);
    const values = jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({ returning }),
    });
    const tx = { insert: jest.fn().mockReturnValue({ values }) };
    const db = {
      transaction: jest.fn(
        (callback: (transaction: typeof tx) => unknown) => callback(tx),
      ),
    };
    const service = new LeaveTypesService(db as never);

    const result = await service.seedDefaults("org-1");
    expect(result).toEqual({ seeded: 2, skipped: 3 });
    const seededRows = values.mock.calls[0][0] as { orgId: string; name: string }[];
    expect(seededRows).toHaveLength(5);
    expect(seededRows.every((r) => r.orgId === "org-1")).toBe(true);
    expect(seededRows.map((r) => r.name)).toContain("Sick Leave");
  });

  it("updates days per year on an org-scoped leave type", async () => {
    const returning = jest.fn().mockResolvedValue([
      { id: 2, name: "Sick Leave", daysPerYear: 6, carryForward: false },
    ]);
    const db = {
      query: { leaveTypes: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning }),
        }),
      }),
    };
    const service = new LeaveTypesService(db as never);

    const updated = await service.update("org-1", 2, { daysPerYear: 6 });
    expect(updated.daysPerYear).toBe(6);
  });

  it("refuses to delete a leave type that has leave requests", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 2 }]),
          }),
        }),
      }),
      query: {
        leaveRequests: { findFirst: jest.fn().mockResolvedValue({ id: 77 }) },
        leavePolicies: { findFirst: jest.fn() },
      },
      delete: jest.fn(),
    };
    const service = new LeaveTypesService(db as never);

    await expect(service.delete("org-1", 2)).rejects.toBeInstanceOf(ConflictException);
    expect(db.delete).not.toHaveBeenCalled();
  });
});
