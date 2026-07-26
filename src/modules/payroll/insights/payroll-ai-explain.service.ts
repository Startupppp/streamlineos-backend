import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payslipPublications,
  payrollRunEmployees,
  payrollRuns,
  payrollLineItems,
} from "../../../db/schema";
import { AiGatewayService } from "../../ai/gateway/ai-gateway.service";
import {
  PAYROLL_AI_CAPABILITY,
  FORBIDDEN_PAYROLL_AI_ACTIONS,
  buildPayslipEvidenceCitations,
  type EvidenceCitation,
} from "./payroll-ai-guardrails";

const FEATURE_KEY = "payroll.explain-payslip" as const;

export interface PayslipExplanation {
  explanation: string;
  evidenceSnapshot: Record<string, unknown>;
  /** Engine field paths that grounded the narrative (Phase 11 citations). */
  citations: EvidenceCitation[];
  capability: typeof PAYROLL_AI_CAPABILITY;
  forbiddenActions: typeof FORBIDDEN_PAYROLL_AI_ACTIONS;
}

function buildSystemPrompt(): string {
  return [
    "You are a payroll assistant narrating a pre-computed payslip for an employee.",
    "CRITICAL RULES — never violate:",
    "1. You MUST NOT compute, derive, invent, or recalculate any number. All monetary amounts, days, hours, and totals are provided to you as already-computed figures from the payroll engine.",
    "2. You MUST NOT contradict, adjust, or question the figures in the evidence. They are authoritative.",
    "3. Your only job is to narrate in plain language what each pre-computed section means for the employee.",
    "4. Keep the explanation to 4-6 sentences. Be empathetic and clear — the reader is the employee.",
    "5. Never mention taxes as an estimate. Only reference tax figures that are explicitly provided.",
    "6. You MUST NOT approve, pay, file, lock, or change payroll. Explanation only.",
  ].join("\n");
}

function buildUserPrompt(evidence: Record<string, unknown>): string {
  return [
    "Payslip data (all values are pre-computed by the payroll engine — do not modify, re-derive, or invent any numbers):",
    JSON.stringify(evidence, null, 2),
    "",
    "Write a 4-6 sentence plain-language explanation of this payslip for the employee. Narrate what the earnings, deductions, and net pay mean. Do not compute anything.",
  ].join("\n");
}

@Injectable()
export class PayrollAiExplainService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async explainPayslip(orgId: string, userId: string, publicationId: number): Promise<PayslipExplanation> {
    const pub = await this.db
      .select({
        pubId: payslipPublications.id,
        pubOrgId: payslipPublications.orgId,
        pubUserId: payslipPublications.userId,
        pubStatus: payslipPublications.status,
        runEmployeeId: payslipPublications.runEmployeeId,
        month: payrollRuns.month,
        gross: payrollRunEmployees.gross,
        totalDeductions: payrollRunEmployees.totalDeductions,
        net: payrollRunEmployees.net,
        currency: payrollRunEmployees.currency,
        scheduledDays: payrollRunEmployees.scheduledDays,
        paidDays: payrollRunEmployees.paidDays,
        lopDays: payrollRunEmployees.lopDays,
        overtimeHours: payrollRunEmployees.overtimeHours,
        workerType: payrollRunEmployees.workerType,
      })
      .from(payslipPublications)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payslipPublications.runId))
      .innerJoin(payrollRunEmployees, eq(payrollRunEmployees.id, payslipPublications.runEmployeeId))
      .where(and(eq(payslipPublications.id, publicationId), eq(payslipPublications.orgId, orgId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!pub) throw new NotFoundException("Payslip not found");
    if (pub.pubUserId !== userId) throw new ForbiddenException("Access denied");
    if (pub.pubStatus !== "PUBLISHED") throw new ForbiddenException("Payslip is not published");

    const lineItems = await this.db
      .select({
        name: payrollLineItems.name,
        category: payrollLineItems.category,
        amount: payrollLineItems.amount,
        taxable: payrollLineItems.taxable,
      })
      .from(payrollLineItems)
      .where(and(eq(payrollLineItems.orgId, orgId), eq(payrollLineItems.runEmployeeId, pub.runEmployeeId)));

    const earnings = lineItems.filter((l) => l.category === "EARNING");
    const deductions = lineItems.filter((l) => l.category === "DEDUCTION");
    const employerContribs = lineItems.filter((l) => l.category === "EMPLOYER_CONTRIBUTION");

    const evidence: Record<string, unknown> = {
      month: pub.month,
      currency: pub.currency,
      workerType: pub.workerType,
      scheduledDays: pub.scheduledDays,
      paidDays: pub.paidDays,
      lopDays: pub.lopDays,
      overtimeHours: pub.overtimeHours,
      grossEarnings: pub.gross,
      totalDeductions: pub.totalDeductions,
      netPay: pub.net,
      earningsBreakdown: earnings.map((e) => ({ name: e.name, amount: e.amount, taxable: e.taxable })),
      deductionsBreakdown: deductions.map((d) => ({ name: d.name, amount: d.amount })),
      employerContributions: employerContribs.map((c) => ({ name: c.name, amount: c.amount })),
    };

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: FEATURE_KEY,
      tier: "fast",
      maxTokens: 400,
      charge: true,
      redact: false,
      prompt: {
        system: buildSystemPrompt(),
        user: buildUserPrompt(evidence),
        promptKey: "payroll.explain-payslip",
        promptVersion: 1,
      },
    });

    if (!result.ok) throw new ServiceUnavailableException(result.message);

    return {
      explanation: result.data,
      evidenceSnapshot: evidence,
      citations: buildPayslipEvidenceCitations(evidence),
      capability: PAYROLL_AI_CAPABILITY,
      forbiddenActions: FORBIDDEN_PAYROLL_AI_ACTIONS,
    };
  }

  /** Public capability surface for ESS / admin honesty banners. */
  capabilities() {
    return {
      ...PAYROLL_AI_CAPABILITY,
      forbiddenActions: FORBIDDEN_PAYROLL_AI_ACTIONS,
      features: [
        {
          key: FEATURE_KEY,
          mode: "narrate_precomputed_payslip",
          requiresPublishedPayslip: true,
        },
      ],
    };
  }
}
