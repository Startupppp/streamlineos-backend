import { seedEmployeeSalaryProfile } from "../salary-profile-seed.helper";

describe("seedEmployeeSalaryProfile", () => {
  it("creates profile and assigns org components with BASIC amount", async () => {
    const insertProfile = {
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 11 }]),
      }),
    };
    const insertComponents = {
      values: jest.fn().mockResolvedValue(undefined),
    };
    let insertCall = 0;

    const tx = {
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        return insertCall === 1 ? insertProfile : insertComponents;
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                {
                  id: 1,
                  code: "BASIC",
                  type: "EARNING",
                  calcMethod: "FIXED",
                  amount: null,
                  percent: null,
                  sortOrder: 1,
                  includeInCtc: true,
                },
                {
                  id: 2,
                  code: "HRA",
                  type: "EARNING",
                  calcMethod: "FIXED",
                  amount: null,
                  percent: null,
                  sortOrder: 2,
                  includeInCtc: true,
                },
              ]),
            }),
          }),
        }),
      }),
      update: jest.fn(),
    };

    const result = await seedEmployeeSalaryProfile(tx as never, {
      orgId: "org-1",
      userId: "user-1",
      actorId: "actor-1",
      monthlySalary: 100000,
      effectiveFrom: "2026-07-01",
    });

    expect(result).toEqual({ profileId: 11, componentCount: 2 });
    expect(insertComponents.values).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          componentId: 1,
          amount: "40000.00",
        }),
        expect.objectContaining({
          componentId: 2,
          amount: "20000.00",
        }),
      ]),
    );
  });
});
