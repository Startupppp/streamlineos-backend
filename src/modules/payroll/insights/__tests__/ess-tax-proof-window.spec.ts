import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { EssSelfServiceService } from "../ess-self-service.service";

describe("EssSelfServiceService.addTaxProof — window gating", () => {
  function buildDb(window: { status: string; lockDate: string | null } | undefined) {
    return {
      query: {
        taxDeclarations: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, userId: "user-1", orgId: "org-1" }),
        },
      },
    };
  }

  function buildEss(window: { status: string; lockDate: string | null } | undefined) {
    return {
      getActiveToggles: jest.fn().mockResolvedValue({ essAllowTaxDeclarations: true }),
      getActiveWindow: jest.fn().mockResolvedValue(window),
    };
  }

  const taxService = { addProof: jest.fn().mockResolvedValue({ id: 1 }) };

  beforeEach(() => taxService.addProof.mockClear());

  it("403s when no tax declaration window is open", async () => {
    const db = buildDb(undefined);
    const ess = buildEss(undefined);
    const service = new EssSelfServiceService(
      db as never,
      ess as never,
      undefined as never,
      undefined as never,
      taxService as never,
      undefined as never,
    );

    await expect(
      service.addTaxProof("org-1", "user-1", { declarationId: 1, category: "80C", amount: 5000 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taxService.addProof).not.toHaveBeenCalled();
  });

  it("403s when the window is open but past its lockDate", async () => {
    const db = buildDb({ status: "OPEN", lockDate: "2020-01-01" });
    const ess = buildEss({ status: "OPEN", lockDate: "2020-01-01" });
    const service = new EssSelfServiceService(
      db as never,
      ess as never,
      undefined as never,
      undefined as never,
      taxService as never,
      undefined as never,
    );

    await expect(
      service.addTaxProof("org-1", "user-1", { declarationId: 1, category: "80C", amount: 5000 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taxService.addProof).not.toHaveBeenCalled();
  });

  it("allows adding a proof when the window is open and within its lockDate", async () => {
    const db = buildDb({ status: "OPEN", lockDate: null });
    const ess = buildEss({ status: "OPEN", lockDate: null });
    const service = new EssSelfServiceService(
      db as never,
      ess as never,
      undefined as never,
      undefined as never,
      taxService as never,
      undefined as never,
    );

    await service.addTaxProof("org-1", "user-1", { declarationId: 1, category: "80C", amount: 5000 });
    expect(taxService.addProof).toHaveBeenCalledTimes(1);
  });
});
