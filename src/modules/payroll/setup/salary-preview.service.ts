import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { salaryComponents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { RunDataLoaderService } from "../runs/run-data-loader.service";
import { ctcBreakup, type CtcBreakup } from "../runs/lib/ctc-breakup";
import type { SalaryPreviewInput } from "./dto/setup.schemas";

const MAX_PREVIEW_COMPONENTS = 200;

@Injectable()
export class SalaryPreviewService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly runData: RunDataLoaderService,
  ) {}

  async preview(orgId: string, input: SalaryPreviewInput): Promise<CtcBreakup> {
    const policy = await this.runData.loadPolicy(orgId, null);
    if (!policy) throw new ConflictException("Activate a payroll policy before previewing a salary breakup");

    const filters = [eq(salaryComponents.orgId, orgId), eq(salaryComponents.isActive, true)];
    const componentIds = input.componentIds ? [...new Set(input.componentIds)] : null;
    if (componentIds) filters.push(inArray(salaryComponents.id, componentIds));

    const components = await this.db
      .select({
        id: salaryComponents.id,
        code: salaryComponents.code,
        name: salaryComponents.name,
        type: salaryComponents.type,
        calcMethod: salaryComponents.calcMethod,
        amount: salaryComponents.amount,
        percent: salaryComponents.percent,
        formula: salaryComponents.formula,
        taxable: salaryComponents.taxable,
        showOnPayslip: salaryComponents.showOnPayslip,
        includeInCtc: salaryComponents.includeInCtc,
        isStatutory: salaryComponents.isStatutory,
        sortOrder: salaryComponents.sortOrder,
      })
      .from(salaryComponents)
      .where(and(...filters))
      .orderBy(asc(salaryComponents.sortOrder), asc(salaryComponents.id))
      .limit(MAX_PREVIEW_COMPONENTS);

    if (componentIds && components.length !== componentIds.length) {
      throw new NotFoundException("One or more components were not found");
    }

    const stateCode = input.stateCode ?? (await this.runData.loadStatutoryStateCode(orgId, null));

    return ctcBreakup({
      annualCtc: input.annualCtc,
      components,
      toggles: policy.toggles,
      config: policy.config,
      month: new Date().toISOString().slice(0, 7),
      regime: input.regime ?? null,
      stateCode,
      workerType: input.workerType ?? "EMPLOYEE",
      currency: "INR",
      policyVersionId: policy.policyVersionId,
    });
  }
}
