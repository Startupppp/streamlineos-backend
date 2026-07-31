import { PersonEmploymentSyncService } from "../../person-employment-sync.service";

describe("PersonEmploymentSyncService.backfillOrg", () => {
  it("scans members and aggregates create counts", async () => {
    const ensureFromUserId = jest
      .fn()
      .mockResolvedValueOnce({
        personId: 1,
        employmentId: 1,
        createdPerson: true,
        createdEmployment: true,
      })
      .mockResolvedValueOnce({
        personId: 2,
        employmentId: 2,
        createdPerson: false,
        createdEmployment: false,
      })
      .mockResolvedValueOnce(null);

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            { userId: "u1" },
            { userId: "u2" },
            { userId: "u3" },
          ]),
        }),
      }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new PersonEmploymentSyncService(db as never, audit as never);
    service.ensureFromUserId = ensureFromUserId;

    const result = await service.backfillOrg("org-1", "actor-1");

    expect(result).toEqual({
      scanned: 3,
      createdPeople: 1,
      createdEmployments: 1,
      skipped: 2,
      errors: [],
    });
    expect(audit.log).toHaveBeenCalled();
  });
});
