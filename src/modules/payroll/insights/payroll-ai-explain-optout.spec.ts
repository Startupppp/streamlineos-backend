import { Reflector } from "@nestjs/core";
import { INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { AiRequestAbortInterceptor } from "../../ai/core/streaming/ai-request-abort.interceptor";
import { PayrollAiExplainController } from "./payroll-ai-explain.controller";

describe("payroll AI explain runs outside the request transaction", () => {
  const reflector = new Reflector();

  function interceptorsOn(handler: (...args: never[]) => unknown): unknown[] {
    return (Reflect.getMetadata(INTERCEPTORS_METADATA, handler) as unknown[]) ?? [];
  }

  it.each([
    ["explainPayslip", PayrollAiExplainController.prototype.explainPayslip],
    ["streamExplainPayslip", PayrollAiExplainController.prototype.streamExplainPayslip],
  ])("%s does not hold a connection across the model call", (_name, handler) => {
    expect(reflector.get<boolean | undefined>(NO_TENANT_TRANSACTION, handler)).toBe(true);
  });

  it.each([
    ["explainPayslip", PayrollAiExplainController.prototype.explainPayslip],
    ["streamExplainPayslip", PayrollAiExplainController.prototype.streamExplainPayslip],
  ])("%s keeps an abort signal, so a released connection is not paid for twice", (_name, handler) => {
    expect(interceptorsOn(handler)).toContain(AiRequestAbortInterceptor);
  });

  it("leaves the capability read inside the request transaction, because it makes no model call", () => {
    expect(
      reflector.get<boolean | undefined>(
        NO_TENANT_TRANSACTION,
        PayrollAiExplainController.prototype.aiCapabilities,
      ),
    ).toBeUndefined();
  });
});
