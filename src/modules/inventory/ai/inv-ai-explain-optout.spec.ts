import { Reflector } from "@nestjs/core";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { InvAiExplainController } from "./inv-ai-explain.controller";

describe("inventory AI explain runs outside the request transaction", () => {
  const reflector = new Reflector();

  it.each([
    ["explainInsight", InvAiExplainController.prototype.explainInsight],
    ["narrateOpsBrief", InvAiExplainController.prototype.narrateOpsBrief],
  ])("%s does not hold a connection across the model call", (_name, handler) => {
    expect(reflector.get<boolean | undefined>(NO_TENANT_TRANSACTION, handler)).toBe(true);
  });

  it("leaves the plain ops-brief aggregate inside the request transaction", () => {
    expect(
      reflector.get<boolean | undefined>(
        NO_TENANT_TRANSACTION,
        InvAiExplainController.prototype.getOpsBrief,
      ),
    ).toBeUndefined();
  });
});
