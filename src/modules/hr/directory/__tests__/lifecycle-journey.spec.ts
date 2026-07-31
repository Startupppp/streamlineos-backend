/**
 * Phase 2.1 contract journey:
 * offer handoff → person exists → onboard marks ONBOARDING → salary profile seed shape.
 */
import { RecruitmentHandoffService } from "../../recruitment/recruitment-handoff.service";
import { seedEmployeeSalaryProfile } from "../../salary-profile-seed.helper";

describe("Phase 2.1 lifecycle journey (contracts)", () => {
  it("handoff reuses person; salary seed creates profile with components", async () => {
    let insertCall = 0;
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([
              {
                id: 1,
                code: "BASIC",
                type: "EARNING",
                calcMethod: "FIXED",
                amount: null,
                percent: null,
                sortOrder: 0,
                includeInCtc: true,
              },
            ]),
          }),
        }),
      }),
      query: {
        hrPeople: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, userId: null }),
        },
        hrEmployments: {
          findFirst: jest.fn().mockResolvedValue({ id: 50 }),
        },
        users: { findFirst: jest.fn() },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        if (insertCall <= 1) {
          return {
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: insertCall === 1 ? 50 : 11 }]),
              onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
            }),
          };
        }
        return {
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 11 }]),
            onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          }),
        };
      }),
    };

    const handoffDb = {
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
    const handoff = new RecruitmentHandoffService(handoffDb as never, audit as never);
    await handoff.handleOfferAccepted("org-1", 99, 12);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ personId: 7, reusedPerson: true }),
      }),
    );

    insertCall = 0;
    const seedTx = {
      insert: jest.fn().mockImplementation(() => {
        insertCall += 1;
        if (insertCall === 1) {
          return {
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 11 }]),
            }),
          };
        }
        return { values: jest.fn().mockResolvedValue(undefined) };
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([
              {
                id: 1,
                code: "BASIC",
                type: "EARNING",
                calcMethod: "FIXED",
                amount: null,
                percent: null,
                sortOrder: 0,
                includeInCtc: true,
              },
            ]),
          }),
        }),
      }),
      update: jest.fn(),
    };

    const seeded = await seedEmployeeSalaryProfile(seedTx as never, {
      orgId: "org-1",
      userId: "user-ada",
      actorId: "hr-1",
      monthlySalary: 100000,
      effectiveFrom: "2026-08-01",
    });

    expect(seeded.profileId).toBe(11);
    expect(seeded.componentCount).toBe(1);
  });
});
