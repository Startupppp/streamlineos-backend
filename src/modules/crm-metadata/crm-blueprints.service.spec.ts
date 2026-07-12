import { CrmBlueprintsService } from "./crm-blueprints.service";

function makeStage(key: string, allowedNextStageKeys: string[] | null) {
  return { allowedNextStageKeys };
}

function makeTransition(
  fromStageKey: string,
  toStageKey: string,
  requiredFields: string[] = [],
  requiresApproval = false,
  requiresQuote = false,
) {
  return {
    id: "t1",
    orgId: "org1",
    blueprintId: "bp1",
    fromStageKey,
    toStageKey,
    requiredFields,
    requiredActivityTypeKeys: [],
    requiresApproval,
    requiresQuote,
    autoTaskTemplates: [],
    sortOrder: 0,
  };
}

describe("CrmBlueprintsService.assertTransitionAllowed", () => {
  let svc: CrmBlueprintsService;

  const stageSelectChain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: jest.fn(),
  };

  const blueprintSelectChain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: jest.fn(),
  };

  const transitionSelectChain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: jest.fn(),
  };

  let selectCallCount = 0;

  const mockDb = {
    select: jest.fn(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) return stageSelectChain;
      if (selectCallCount === 2) return blueprintSelectChain;
      return transitionSelectChain;
    }),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    then: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    svc = new CrmBlueprintsService(mockDb as never);
    jest.clearAllMocks();
    selectCallCount = 0;
  });

  function stubStage(stage: ReturnType<typeof makeStage> | undefined) {
    stageSelectChain.then.mockImplementation((cb: (rows: unknown[]) => unknown) =>
      Promise.resolve(cb(stage ? [stage] : [])),
    );
  }

  function stubBlueprint(blueprint: { id: string } | undefined) {
    blueprintSelectChain.then.mockImplementation((cb: (rows: unknown[]) => unknown) =>
      Promise.resolve(cb(blueprint ? [blueprint] : [])),
    );
  }

  function stubTransition(transition: ReturnType<typeof makeTransition> | undefined) {
    transitionSelectChain.then.mockImplementation((cb: (rows: unknown[]) => unknown) =>
      Promise.resolve(cb(transition ? [transition] : [])),
    );
  }

  describe("fail-open when no config", () => {
    it("allows transition when stage not found in DB", async () => {
      stubStage(undefined);
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "NEW", "QUALIFIED", {});
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.missingFields).toHaveLength(0);
    });

    it("allows transition when stage exists but no blueprint found", async () => {
      stubStage(makeStage("NEW", null));
      stubBlueprint(undefined);
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "NEW", "QUALIFIED", {});
      expect(result.allowed).toBe(true);
    });

    it("allows transition when blueprint exists but no transition rule found", async () => {
      stubStage(makeStage("NEW", null));
      stubBlueprint({ id: "bp1" });
      stubTransition(undefined);
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "NEW", "QUALIFIED", {});
      expect(result.allowed).toBe(true);
    });
  });

  describe("allowedNextStageKeys enforcement", () => {
    it("blocks transition when toStageKey not in allowed list", async () => {
      stubStage(makeStage("NEW", ["CONTACTED"]));
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "NEW", "QUALIFIED", {});
      expect(result.allowed).toBe(false);
    });

    it("allows transition when toStageKey is in allowed list", async () => {
      stubStage(makeStage("NEW", ["CONTACTED", "QUALIFIED"]));
      stubBlueprint(undefined);
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "NEW", "QUALIFIED", {});
      expect(result.allowed).toBe(true);
    });

    it("allows any transition when allowedNextStageKeys is null", async () => {
      stubStage(makeStage("NEW", null));
      stubBlueprint(undefined);
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "NEW", "QUALIFIED", {});
      expect(result.allowed).toBe(true);
    });
  });

  describe("blueprint transition rules", () => {
    it("allows when all required fields are present", async () => {
      stubStage(makeStage("PROPOSAL", null));
      stubBlueprint({ id: "bp1" });
      stubTransition(makeTransition("PROPOSAL", "WON", ["closeDate", "contactEmail"]));
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "PROPOSAL", "WON", {
        closeDate: "2026-12-31",
        contactEmail: "buyer@example.com",
      });
      expect(result.allowed).toBe(true);
      expect(result.missingFields).toHaveLength(0);
    });

    it("blocks and reports missing fields", async () => {
      stubStage(makeStage("PROPOSAL", null));
      stubBlueprint({ id: "bp1" });
      stubTransition(makeTransition("PROPOSAL", "WON", ["closeDate", "contactEmail"]));
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "PROPOSAL", "WON", {
        closeDate: "2026-12-31",
      });
      expect(result.allowed).toBe(false);
      expect(result.missingFields).toContain("contactEmail");
    });

    it("surfaces requiresApproval from transition", async () => {
      stubStage(makeStage("NEGOTIATION", null));
      stubBlueprint({ id: "bp1" });
      stubTransition(makeTransition("NEGOTIATION", "WON", [], true));
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "NEGOTIATION", "WON", {});
      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it("reports multiple missing fields", async () => {
      stubStage(makeStage("NEW", null));
      stubBlueprint({ id: "bp1" });
      stubTransition(makeTransition("NEW", "WON", ["closeDate", "dealValue", "contactEmail"]));
      const result = await svc.assertTransitionAllowed("org1", "pipeline1", "NEW", "WON", {});
      expect(result.allowed).toBe(false);
      expect(result.missingFields).toHaveLength(3);
    });
  });
});
