import "reflect-metadata";
import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { TestSuitesController } from "./test-suites.controller";
import { TestCasesController } from "./test-cases.controller";
import { TestRunsController } from "./test-runs.controller";
import { RisksController } from "../governance/risks.controller";
import { DecisionsController } from "../governance/decisions.controller";

function getIdempotencyCommand(target: object, methodName: string): string | undefined {
  return Reflect.getMetadata(IDEMPOTENCY_COMMAND, (target as Record<string, unknown>)[methodName] as object);
}

describe("TestSuitesController.createSuite — duplicate submission creates two suites until @Idempotent", () => {
  it("carries the idempotency command key", () => {
    const command = getIdempotencyCommand(TestSuitesController.prototype, "createSuite");
    expect(command).toBe("build.qa.test-suite.create");
  });

  it("does not carry a command on the read-only listSuites handler", () => {
    const command = getIdempotencyCommand(TestSuitesController.prototype, "listSuites");
    expect(command).toBeUndefined();
  });
});

describe("TestCasesController.createCase — duplicate submission creates two cases until @Idempotent", () => {
  it("carries the idempotency command key", () => {
    const command = getIdempotencyCommand(TestCasesController.prototype, "createCase");
    expect(command).toBe("build.qa.test-case.create");
  });

  it("does not carry a command on the read-only listCases handler", () => {
    const command = getIdempotencyCommand(TestCasesController.prototype, "listCases");
    expect(command).toBeUndefined();
  });
});

describe("TestRunsController.createRun — duplicate submission creates two runs until @Idempotent", () => {
  it("carries the idempotency command key", () => {
    const command = getIdempotencyCommand(TestRunsController.prototype, "createRun");
    expect(command).toBe("build.qa.test-run.create");
  });

  it("does not carry a command on the read-only listRuns handler", () => {
    const command = getIdempotencyCommand(TestRunsController.prototype, "listRuns");
    expect(command).toBeUndefined();
  });
});

describe("RisksController.createRisk — duplicate submission creates two risks until @Idempotent", () => {
  it("carries the idempotency command key", () => {
    const command = getIdempotencyCommand(RisksController.prototype, "createRisk");
    expect(command).toBe("build.governance.risk.create");
  });

  it("does not carry a command on the read-only listRisks handler", () => {
    const command = getIdempotencyCommand(RisksController.prototype, "listRisks");
    expect(command).toBeUndefined();
  });
});

describe("DecisionsController.createDecision — duplicate submission creates two decisions until @Idempotent", () => {
  it("carries the idempotency command key", () => {
    const command = getIdempotencyCommand(DecisionsController.prototype, "createDecision");
    expect(command).toBe("build.governance.decision.create");
  });

  it("does not carry a command on the read-only listDecisions handler", () => {
    const command = getIdempotencyCommand(DecisionsController.prototype, "listDecisions");
    expect(command).toBeUndefined();
  });
});
