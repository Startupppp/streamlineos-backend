import { PersonEmploymentSyncService } from "../person-employment-sync.service";

const ORG = "org-1";
const USER = "user-1";

const INPUT = {
  userId: USER,
  firstName: "Ada",
  lastName: "Lovelace",
  workEmail: "ada@example.com",
  employeeNumber: "EMP-USER1234",
};

function makeDb(options: {
  deletedPerson: { id: number } | null;
  employmentByNumber: { id: number; personId: number; deletedAt: Date | null } | null;
}) {
  const inserted: string[] = [];
  const updatedEmploymentIds: number[] = [];

  const hrPeopleFindFirst = jest
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(options.deletedPerson);

  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    }),
    query: {
      hrPeople: { findFirst: hrPeopleFindFirst },
      hrEmployments: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(options.employmentByNumber)
          .mockResolvedValue(null),
      },
      organizationPeople: {
        findFirst: jest.fn().mockResolvedValue({ organizationPersonId: "op-1" }),
      },
    },
    insert: jest.fn((table: { _: { name: string } }) => {
      inserted.push(table?._?.name ?? "unknown");
      return {
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 99 }]),
        }),
      };
    }),
    update: jest.fn(() => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockImplementation(() => {
            updatedEmploymentIds.push(options.employmentByNumber?.id ?? -1);
            return Promise.resolve([
              { id: options.employmentByNumber?.id ?? options.deletedPerson?.id ?? 1 },
            ]);
          }),
        }),
      }),
    })),
  };

  return { db, inserted, updatedEmploymentIds };
}

describe("ensureFromUser — a re-added person must not collide with their soft-deleted rows", () => {
  it("restores a soft-deleted employment instead of inserting a duplicate employee number", async () => {
    const { db, inserted } = makeDb({
      deletedPerson: null,
      employmentByNumber: {
        id: 42,
        personId: 99,
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const service = new PersonEmploymentSyncService(db as never, {
      log: jest.fn().mockResolvedValue(undefined),
    } as never);

    const result = await service.ensureFromUser(ORG, "actor-1", INPUT);

    expect(result.employmentId).toBe(42);
    expect(result.createdEmployment).toBe(false);
    expect(inserted).not.toContain("hr_employments");
    expect(db.update).toHaveBeenCalled();
  });

  it("falls back to a suffixed number when the employee number belongs to someone else", async () => {
    const { db } = makeDb({
      deletedPerson: null,
      employmentByNumber: { id: 42, personId: 7, deletedAt: null },
    });

    const service = new PersonEmploymentSyncService(db as never, {
      log: jest.fn().mockResolvedValue(undefined),
    } as never);

    const result = await service.ensureFromUser(ORG, "actor-1", INPUT);

    expect(result.employmentId).toBe(99);
    expect(result.createdEmployment).toBe(true);
  });
});
