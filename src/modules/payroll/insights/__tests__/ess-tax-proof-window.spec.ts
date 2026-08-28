import { ForbiddenException } from "@nestjs/common";
import { EssService } from "../ess.service";

describe("EssService.addTaxProof — is gated by the declaration window (regression: was never checked)", () => {
  function buildDb(policy: { activeVersionId: number | null } | undefined, window: { status: string; lockDate: string | null } | undefined) {
    return {
      query: {
        payrollPolicies: { findFirst: jest.fn().mockResolvedValue(policy) },
        payrollPolicyVersions: {
          findFirst: jest.fn().mockResolvedValue({ toggles: { essAllowTaxDeclarations: true } }),
        },
        taxDeclarations: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, userId: "user-1", orgId: "org-1" }),
        },
        payrollTaxWindows: { findFirst: jest.fn().mockResolvedValue(window) },
      },
    };
  }

  const taxService = { addProof: jest.fn().mockResolvedValue({ id: 1 }) };

  beforeEach(() => taxService.addProof.mockClear());

  it("403s when no tax declaration window is open", async () => {
    const db = buildDb({ activeVersionId: 1 }, undefined);
    const service = new EssService(db as never, undefined as never, undefined as never, taxService as never, undefined as never);

    await expect(
      service.addTaxProof("org-1", "user-1", { declarationId: 1, category: "80C", amount: 5000 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taxService.addProof).not.toHaveBeenCalled();
  });

  it("403s when the window is open but past its lockDate", async () => {
    const db = buildDb({ activeVersionId: 1 }, { status: "OPEN", lockDate: "2020-01-01" });
    const service = new EssService(db as never, undefined as never, undefined as never, taxService as never, undefined as never);

    await expect(
      service.addTaxProof("org-1", "user-1", { declarationId: 1, category: "80C", amount: 5000 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taxService.addProof).not.toHaveBeenCalled();
  });

  it("allows adding a proof when the window is open and within its lockDate", async () => {
    const db = buildDb({ activeVersionId: 1 }, { status: "OPEN", lockDate: null });
    const service = new EssService(db as never, undefined as never, undefined as never, taxService as never, undefined as never);

    await service.addTaxProof("org-1", "user-1", { declarationId: 1, category: "80C", amount: 5000 });
    expect(taxService.addProof).toHaveBeenCalledTimes(1);
  });
});
