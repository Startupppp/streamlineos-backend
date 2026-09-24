import { HrImportCommitService } from "./hr-import-commit.service";

type Tx = {
  query: {
    organizationPeople: { findFirst: jest.Mock };
  };
  insert: jest.Mock;
  select: jest.Mock;
  update: jest.Mock;
};

function insertOnConflictChain(returning: unknown[]) {
  return {
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(returning),
      }),
    }),
  };
}

function insertReturningChain(returning: unknown[]) {
  return {
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue(returning),
    }),
  };
}

function buildTx(overrides: Partial<Tx> = {}): Tx {
  return {
    query: {
      organizationPeople: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn(),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          catch: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    }),
    ...overrides,
  };
}

describe("HrImportCommitService.commitEmployee", () => {
  it("creates a new org person then inserts hr_people with organizationPersonId linked", async () => {
    let insertCall = 0;
    const tx = buildTx({
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        if (insertCall === 1) return insertReturningChain([{ organizationPersonId: "op-1" }]);
        if (insertCall === 2) return insertOnConflictChain([{ id: 42 }]);
        return insertOnConflictChain([{ id: 99 }]);
      }),
    });

    const service = new HrImportCommitService();
    const ref = await service.commitRow(tx as never, "org-1", "employees", {
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      employeeNumber: "EMP-100",
      joiningDate: "2026-01-01",
      designation: "Admiral",
    });

    expect(ref).toEqual({ table: "hr_people", id: 42, outcome: "created" });
    expect(insertCall).toBe(3);
  });

  it("links existing hr_people to canonical org person when the email row already existed", async () => {
    let insertCall = 0;
    const tx = buildTx({
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        if (insertCall === 1) return insertReturningChain([{ organizationPersonId: "op-1" }]);
        return insertOnConflictChain([]);
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ id: 77, organizationPersonId: null }]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 77, organizationPersonId: null }]),
          }),
        }),
      }),
    });

    const service = new HrImportCommitService();
    const ref = await service.commitRow(tx as never, "org-1", "employees", {
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      employeeNumber: "EMP-100",
      joiningDate: "2026-01-01",
      designation: "Admiral",
    });

    expect(ref).toEqual({ table: "hr_people", id: 77, outcome: "updated" });
    expect((tx.update as jest.Mock)).toHaveBeenCalled();
  });

  it("skips updating org person link when existing row is already linked", async () => {
    let insertCall = 0;
    const tx = buildTx({
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        if (insertCall === 1) return insertReturningChain([{ organizationPersonId: "op-1" }]);
        return insertOnConflictChain([]);
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{ id: 77, organizationPersonId: "op-already" }]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 77, organizationPersonId: "op-already" }]),
          }),
        }),
      }),
    });

    const service = new HrImportCommitService();
    const ref = await service.commitRow(tx as never, "org-1", "employees", {
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      employeeNumber: "EMP-100",
      joiningDate: "",
    });

    expect(ref).toEqual({ table: "hr_people", id: 77, outcome: "updated" });
    expect((tx.update as jest.Mock)).not.toHaveBeenCalled();
  });
});
