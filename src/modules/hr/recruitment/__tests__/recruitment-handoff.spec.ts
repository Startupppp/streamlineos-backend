import { RecruitmentHandoffService } from "../recruitment-handoff.service";

describe("RecruitmentHandoffService", () => {
  it("reuses person by email, links canonical org person, and does not create a second hr_people row", async () => {
    let insertCall = 0;

    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest
                .fn()
                .mockResolvedValue([{ id: 7, userId: null, organizationPersonId: null }]),
            }),
          }),
        }),
      }),
      query: {
        organizationPeople: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        hrPeople: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, userId: null, organizationPersonId: null }),
        },
        hrEmployments: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        users: {
          findFirst: jest.fn(),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      }),
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        if (insertCall === 1) {
          return {
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockReturnValue({
                then: jest.fn().mockResolvedValue("op-1"),
              }),
            }),
          };
        }
        if (insertCall === 2) {
          return {
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 50 }]),
            }),
          };
        }
        return {
          values: jest.fn().mockReturnValue({
            onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          }),
        };
      }),
    };

    const db = {
      query: {
        candidates: {
          findFirst: jest.fn().mockResolvedValue({
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            phone: null,
          }),
        },
        candidateOffers: {
          findFirst: jest.fn().mockResolvedValue({
            offeredSalary: "100000",
            offeredDesignation: "Engineer",
            joiningDate: "2026-08-01",
          }),
        },
      },
      transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    };

    const audit = { log: jest.fn() };
    const service = new RecruitmentHandoffService(db as never, audit as never);

    await service.handleOfferAccepted("org-1", 99, 12);

    expect(tx.query.organizationPeople.findFirst).toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "OFFER_ACCEPTED_HANDOFF",
        metadata: expect.objectContaining({
          personId: 7,
          candidateId: 99,
          reusedPerson: true,
        }),
      }),
    );
  });
});
