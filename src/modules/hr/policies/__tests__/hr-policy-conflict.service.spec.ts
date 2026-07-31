import { HrPolicyConflictService } from "../../hr-policy-conflict.service";

describe("HrPolicyConflictService", () => {
  it("flags equal-priority overlapping org-scope policies as blocking", async () => {
    const db = {
      query: {
        hrPolicies: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            name: "Leave A",
            policyType: "leave",
            priority: 10,
            effectiveFrom: "2026-01-01",
            effectiveTo: null,
            scopes: [{ scopeType: "organization", scopeValue: "org-1" }],
          }),
          findMany: jest.fn().mockResolvedValue([
            {
              id: 2,
              name: "Leave B",
              policyType: "leave",
              priority: 10,
              effectiveFrom: "2026-01-01",
              effectiveTo: null,
              scopes: [{ scopeType: "organization", scopeValue: "org-1" }],
            },
          ]),
        },
      },
    };

    const service = new HrPolicyConflictService(db as never);
    const result = await service.detectConflicts("org-1", 1);

    expect(result.canActivate).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe("blocking");
  });

  it("treats lower-priority overlaps as warnings", async () => {
    const db = {
      query: {
        hrPolicies: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            name: "Leave A",
            policyType: "leave",
            priority: 20,
            effectiveFrom: "2026-01-01",
            effectiveTo: null,
            scopes: [{ scopeType: "organization", scopeValue: "org-1" }],
          }),
          findMany: jest.fn().mockResolvedValue([
            {
              id: 2,
              name: "Leave B",
              policyType: "leave",
              priority: 5,
              effectiveFrom: "2026-01-01",
              effectiveTo: null,
              scopes: [{ scopeType: "organization", scopeValue: "org-1" }],
            },
          ]),
        },
      },
    };

    const service = new HrPolicyConflictService(db as never);
    const result = await service.detectConflicts("org-1", 1);

    expect(result.canActivate).toBe(true);
    expect(result.conflicts[0].severity).toBe("warning");
  });
});
