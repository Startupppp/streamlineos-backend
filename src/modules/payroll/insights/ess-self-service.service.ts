import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  auditLogs,
  payrollRuns,
  taxDeclarations,
} from "../../../db/schema";
import { LoansService } from "../hr-payroll/loans.service";
import { ReimbursementsService } from "../hr-payroll/reimbursements.service";
import { selfOnlyReimbursementsRead } from "../hr-payroll/reimbursements-scope";
import { TaxService } from "../hr-payroll/tax.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { type BankDetails } from "../../hr/onboarding/core/crypto.helpers";
import { upsertCanonicalSensitiveFields } from "../../../common/hr/sync-canonical-sensitive-fields";
import { detectScheme, validateSchemeCode } from "../payout/lib/bank-validation";
import type { EssBank } from "./dto/insights.schemas";
import { EssService } from "./ess.service";
import { multiplyDecimals, roundDecimal, toDecimal } from "../../accounting/core/money.util";

function withOutstandingBalance<
  T extends { totalEmis: number | null; paidEmis: number; emiAmount: string | null },
>(loan: T): T & { balance: string } {
  return {
    ...loan,
    balance: roundDecimal(
      multiplyDecimals(String((loan.totalEmis ?? 0) - loan.paidEmis), toDecimal(loan.emiAmount)),
      2,
    ),
  };
}

@Injectable()
export class EssSelfServiceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ess: EssService,
    private readonly loansService: LoansService,
    private readonly reimbursementsService: ReimbursementsService,
    private readonly taxService: TaxService,
    private readonly employmentFacts: EmploymentFactsService,
  ) {}

  async createReimbursement(
    orgId: string,
    userId: string,
    membershipId: number | null,
    body: { category: string; amount: number; description?: string; receiptUrl?: string; payrollMonth?: string },
  ) {
    const toggles = await this.ess.getActiveToggles(orgId);
    if (!toggles.essAllowReimbursements) throw new ForbiddenException("Reimbursements are disabled");
    return this.reimbursementsService.createReimbursement(orgId, userId, membershipId, {
      category: body.category,
      amount: body.amount,
      description: body.description,
      receiptUrl: body.receiptUrl,
      payrollMonth: body.payrollMonth,
    });
  }

  async listReimbursements(orgId: string, userId: string, membershipId: number | null, page = 1, limit = 50) {
    const toggles = await this.ess.getActiveToggles(orgId);
    if (!toggles.essAllowReimbursements) throw new ForbiddenException("Reimbursements are disabled");
    return this.reimbursementsService.listReimbursements(selfOnlyReimbursementsRead(orgId, userId), membershipId, page, Math.min(limit, 100));
  }

  async listLoans(orgId: string, userId: string, membershipId: number | null) {
    const toggles = await this.ess.getActiveToggles(orgId);
    if (!toggles.essAllowLoanRequests) throw new ForbiddenException("Loan requests are disabled");
    const loans = await this.loansService.listLoans(orgId, userId, membershipId, false);
    return loans.items.map(withOutstandingBalance);
  }

  async createLoan(orgId: string, userId: string, membershipId: number | null, body: { amount: number; reason: string; totalEmis: number }) {
    const toggles = await this.ess.getActiveToggles(orgId);
    if (!toggles.essAllowLoanRequests) throw new ForbiddenException("Loan requests are disabled");
    const loan = await this.loansService.createLoan(orgId, userId, membershipId, false, { amount: body.amount, reason: body.reason, totalEmis: body.totalEmis });
    return withOutstandingBalance(loan);
  }

  async getTaxDeclaration(orgId: string, userId: string) {
    const [toggles, window] = await Promise.all([
      this.ess.getActiveToggles(orgId),
      this.ess.getActiveWindow(orgId),
    ]);
    if (!toggles.essAllowTaxDeclarations) throw new ForbiddenException("Tax declarations are disabled");
    if (!window) return { windowStatus: null, declaration: null, proofs: [] };

    const declarations = await this.taxService.listMine(orgId, userId);
    const declaration = declarations.find((d) => d.financialYear === window.financialYear) ?? null;
    const proofs = declaration ? await this.taxService.listProofs(orgId, declaration.id) : [];

    return { windowStatus: "OPEN" as const, financialYear: window.financialYear, closesAt: window.closesAt, declaration, proofs };
  }

  async submitTaxDeclaration(
    orgId: string,
    userId: string,
    body: {
      financialYear: string;
      regime: "OLD" | "NEW";
      hra?: number;
      lta?: number;
      section80c?: number;
      section80d?: number;
      section80g?: number;
      homeLoanInterest?: number;
    },
  ) {
    const toggles = await this.ess.getActiveToggles(orgId);
    if (!toggles.essAllowTaxDeclarations) throw new ForbiddenException("Tax declarations are disabled");
    const window = await this.ess.getActiveWindow(orgId);
    if (!window) throw new ForbiddenException("Tax declaration window is not open");

    if (window.lockDate) {
      const todayIso = new Date().toISOString().slice(0, 10);
      if (todayIso > window.lockDate) {
        throw new ForbiddenException(
          `Tax declaration window is locked — submission deadline was ${window.lockDate}`,
        );
      }
    }

    return this.taxService.createOrUpdate(orgId, userId, {
      financialYear: body.financialYear,
      regime: body.regime,
      hra: body.hra?.toString(),
      lta: body.lta?.toString(),
      section80c: body.section80c?.toString(),
      section80d: body.section80d?.toString(),
      section80g: body.section80g?.toString(),
      homeLoanInterest: body.homeLoanInterest?.toString(),
      status: "SUBMITTED",
    });
  }

  async addTaxProof(
    orgId: string,
    userId: string,
    body: { declarationId: number; category: string; amount: number; description?: string; proofUrl?: string },
  ) {
    const [toggles, declaration, window] = await Promise.all([
      this.ess.getActiveToggles(orgId),
      this.db.query.taxDeclarations.findFirst({
        where: and(eq(taxDeclarations.id, body.declarationId), eq(taxDeclarations.userId, userId), eq(taxDeclarations.orgId, orgId)),
      }),
      this.ess.getActiveWindow(orgId),
    ]);
    if (!toggles.essAllowTaxDeclarations) throw new ForbiddenException("Tax declarations are disabled");
    if (!declaration) throw new NotFoundException("Tax declaration not found");
    if (!window) throw new ForbiddenException("Tax declaration window is not open");
    if (window.lockDate) {
      const todayIso = new Date().toISOString().slice(0, 10);
      if (todayIso > window.lockDate) {
        throw new ForbiddenException(
          `Tax declaration window is locked — submission deadline was ${window.lockDate}`,
        );
      }
    }

    return this.taxService.addProof(orgId, body.declarationId, {
      category: body.category,
      amount: body.amount.toString(),
      description: body.description,
      proofUrl: body.proofUrl,
    });
  }

  async getBankDetails(orgId: string, userId: string) {
    const toggles = await this.ess.getActiveToggles(orgId);
    if (!toggles.essAllowBankUpdate) throw new ForbiddenException("Bank details access is disabled");
    const sensitive = await this.employmentFacts.getSensitiveFacts(orgId, userId);
    const details = sensitive.bankDetails;
    if (!details) return { hasBank: false, masked: null };
    return {
      hasBank: true,
      masked: {
        accountNumber: `****${details.accountNumber.slice(-4)}`,
        bankName: details.bankName,
        branch: details.branch,
        ifsc: details.ifsc,
        accountHolder: details.accountHolder,
        bankCountry: details.bankCountry ?? null,
      },
    };
  }

  async updateBankDetails(orgId: string, userId: string, body: EssBank) {
    const toggles = await this.ess.getActiveToggles(orgId);
    if (!toggles.essAllowBankUpdate) throw new ForbiddenException("Bank details update is disabled");

    const activeRun = await this.db.query.payrollRuns.findFirst({
      where: and(
        eq(payrollRuns.orgId, orgId),
        inArray(payrollRuns.status, ["LOCKED", "APPROVED", "PAID", "PAYSLIPS_PUBLISHED"]),
      ),
      columns: { id: true, status: true, month: true },
    });
    if (activeRun) {
      throw new ConflictException(
        `Bank details are frozen: payroll run ${activeRun.month} is in status ${activeRun.status}. Contact HR to update after payout is complete.`,
      );
    }

    const effectiveCode = body.code ?? body.ifsc ?? "";
    const effectiveHolder = body.accountHolder ?? body.accountHolderName ?? "";
    const effectiveCountry = body.bankCountry ?? "IN";
    const scheme = detectScheme(effectiveCountry);
    const codeValidation = validateSchemeCode(scheme, effectiveCode);
    if (!codeValidation.valid) {
      throw new BadRequestException(codeValidation.issue ?? `Invalid ${codeValidation.label}`);
    }

    const stored: BankDetails = {
      accountNumber: body.accountNumber,
      bankName: body.bankName ?? "",
      branch: body.branch ?? "",
      ifsc: effectiveCode,
      accountHolder: effectiveHolder,
      pfUanNumber: body.pfUanNumber,
      bankCountry: body.bankCountry,
    };

    await this.db.transaction(async (tx) => {
      const written = await upsertCanonicalSensitiveFields(tx, orgId, userId, { bankDetails: stored });
      if (!written) {
        throw new ConflictException(
          "Your employment record is not set up yet, so bank details cannot be saved. Contact HR.",
        );
      }
      await tx.insert(auditLogs).values({
        action: "bank_details.updated",
        userId,
        orgId,
        actorUserId: userId,
        resourceType: "user",
        resourceId: userId,
      });
    });
    return { updated: true };
  }
}
