import { PersonEmploymentSyncService } from "../person-employment-sync.service";

describe("PersonEmploymentSyncService", () => {
  it("creates person and employment when neither exists, linking to a new canonical person", async () => {
    const insertOrgPerson = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ organizationPersonId: "op-1" }]),
      }),
    });
    const insertPeople = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 10 }]),
      }),
    });
    const insertEmp = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 20 }]),
      }),
    });

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      query: {
        hrPeople: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null),
        },
        hrEmployments: {
          findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        },
        organizationPeople: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null),
        },
      },
      insert: jest
        .fn()
        .mockImplementationOnce(() => insertOrgPerson())
        .mockImplementationOnce(() => insertPeople())
        .mockImplementationOnce(() => insertEmp()),
    };

    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new PersonEmploymentSyncService(db as never, audit as never);

    const result = await service.ensureFromUser("org-1", "actor-1", {
      userId: "user-1",
      firstName: "Ada",
      lastName: "Lovelace",
      workEmail: "ada@example.com",
      employeeNumber: "EMP-001",
      joiningDate: "2026-01-01",
      designation: "Engineer",
    });

    expect(result).toEqual({
      personId: 10,
      employmentId: 20,
      createdPerson: true,
      createdEmployment: true,
    });
    expect(audit.log).toHaveBeenCalled();
    const insertedPeopleValues = insertPeople.mock.results[0];
    expect(insertedPeopleValues).toBeDefined();
  });

  it("reuses existing primary employment without querying canonical person", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      query: {
        hrPeople: {
          findFirst: jest.fn().mockResolvedValue({ id: 3, userId: "user-1" }),
        },
        hrEmployments: {
          findFirst: jest.fn().mockResolvedValue({ id: 9, personId: 3 }),
        },
        organizationPeople: {
          findFirst: jest.fn(),
        },
      },
      insert: jest.fn(),
    };
    const audit = { log: jest.fn() };
    const service = new PersonEmploymentSyncService(db as never, audit as never);

    const result = await service.ensureFromUser("org-1", "actor-1", {
      userId: "user-1",
      firstName: "Ada",
      lastName: "Lovelace",
      workEmail: "ada@example.com",
      employeeNumber: "EMP-001",
    });

    expect(result.createdPerson).toBe(false);
    expect(result.createdEmployment).toBe(false);
    expect(result.employmentId).toBe(9);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.query.organizationPeople.findFirst).not.toHaveBeenCalled();
  });
});
