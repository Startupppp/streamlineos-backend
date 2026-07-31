import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRunEmployees,
  payrollRuns,
  payslipPublications,
  reimbursements,
  salaryLoans,
  taxDeclarations,
  users,
  organizationMembers,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { ReimbursementsService } from "../../hr/payroll/reimbursements.service";
import { LoansService } from "../../hr/payroll/loans.service";

export interface ManagerTeamMember {
  userId: string;
  name: string | null;
  email: string | null;
  pendingReimbursements: number;
  pendingLoans: number;
  latestPayslip: {
    month: string;
    net: string | null;
    publicationId: number;
  } | null;
  taxDeclarationStatus: string | null;
  actionCount: number;
}

export interface ManagerPendingReimbursement {
  id: number;
  userId: string;
  userName: string | null;
  category: string;
  amount: string;
  description: string | null;
  createdAt: Date;
}

export interface ManagerPendingLoan {
  id: number;
  userId: string;
  userName: string | null;
  amount: string;
  reason: string | null;
  totalEmis: number | null;
  createdAt: Date;
}

export interface ManagerInboxResult {
  mode: "manager_self_service";
  honestyNote: string;
  reportCount: number;
  canApproveReimbursements: boolean;
  canApproveLoans: boolean;
  members: ManagerTeamMember[];
  pendingReimbursements: ManagerPendingReimbursement[];
  pendingLoans: ManagerPendingLoan[];
  totals: {
    pendingReimbursements: number;
    pendingLoans: number;
    membersNeedingAction: number;
  };
}

/**
 * Manager payroll inbox — direct reports only (users.reportingTo).
 * Approve/reject requires hr:expenses:approve (claims) or hr:loans:manage (loans)
 * AND the subject must report to the actor.
 */
@Injectable()
export class ManagerInboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly reimbursements: ReimbursementsService,
    private readonly loans: LoansService,
  ) {}

  async getInbox(orgId: string, managerUserId: string): Promise<ManagerInboxResult> {
    const perms = await this.access.resolveUserPermissions(orgId, managerUserId);
    // Match admin controllers: reimbursements + loans both gate on hr:expenses:approve;
    // also accept hr:loans:manage for loan actions.
    const canApproveReimbursements = perms.has("hr:expenses:approve");
    const canApproveLoans =
      perms.has("hr:expenses:approve") || perms.has("hr:loans:manage");

    const reports = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(users.reportingTo, managerUserId),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      );

    const honestyNote =
      "Team payroll inbox is limited to your direct reports. Approving claims requires hr:expenses:approve; loans require hr:expenses:approve or hr:loans:manage. You cannot approve your own requests.";

    if (reports.length === 0) {
      return {
        mode: "manager_self_service",
        honestyNote,
        reportCount: 0,
        canApproveReimbursements,
        canApproveLoans,
        members: [],
        pendingReimbursements: [],
        pendingLoans: [],
        totals: {
          pendingReimbursements: 0,
          pendingLoans: 0,
          membersNeedingAction: 0,
        },
      };
    }

    const reportIds = reports.map((r) => r.id);
    const nameByUser = new Map(reports.map((r) => [r.id, r.name]));

    const [reimbRows, loanRows, pubs, taxRows, pendingReimbList, pendingLoanList] =
      await Promise.all([
        this.db
          .select({
            userId: reimbursements.userId,
            total: count(),
          })
          .from(reimbursements)
          .where(
            and(
              eq(reimbursements.orgId, orgId),
              inArray(reimbursements.userId, reportIds),
              eq(reimbursements.status, "PENDING"),
            ),
          )
          .groupBy(reimbursements.userId),
        this.db
          .select({
            userId: salaryLoans.userId,
            total: count(),
          })
          .from(salaryLoans)
          .where(
            and(
              eq(salaryLoans.orgId, orgId),
              inArray(salaryLoans.userId, reportIds),
              eq(salaryLoans.status, "PENDING"),
            ),
          )
          .groupBy(salaryLoans.userId),
        this.db
          .select({
            userId: payslipPublications.userId,
            publicationId: payslipPublications.id,
            publishedAt: payslipPublications.publishedAt,
            month: payrollRuns.month,
            net: payrollRunEmployees.net,
          })
          .from(payslipPublications)
          .innerJoin(payrollRuns, eq(payrollRuns.id, payslipPublications.runId))
          .innerJoin(
            payrollRunEmployees,
            eq(payrollRunEmployees.id, payslipPublications.runEmployeeId),
          )
          .where(
            and(
              eq(payslipPublications.orgId, orgId),
              inArray(payslipPublications.userId, reportIds),
              eq(payslipPublications.status, "PUBLISHED"),
            ),
          )
          .orderBy(desc(payslipPublications.publishedAt)),
        this.db
          .select({
            userId: taxDeclarations.userId,
            status: taxDeclarations.status,
            createdAt: taxDeclarations.createdAt,
          })
          .from(taxDeclarations)
          .where(
            and(eq(taxDeclarations.orgId, orgId), inArray(taxDeclarations.userId, reportIds)),
          )
          .orderBy(desc(taxDeclarations.createdAt)),
        this.db
          .select({
            id: reimbursements.id,
            userId: reimbursements.userId,
            category: reimbursements.category,
            amount: reimbursements.amount,
            description: reimbursements.description,
            createdAt: reimbursements.createdAt,
          })
          .from(reimbursements)
          .where(
            and(
              eq(reimbursements.orgId, orgId),
              inArray(reimbursements.userId, reportIds),
              eq(reimbursements.status, "PENDING"),
            ),
          )
          .orderBy(desc(reimbursements.createdAt))
          .limit(50),
        this.db
          .select({
            id: salaryLoans.id,
            userId: salaryLoans.userId,
            amount: salaryLoans.amount,
            reason: salaryLoans.reason,
            totalEmis: salaryLoans.totalEmis,
            createdAt: salaryLoans.createdAt,
          })
          .from(salaryLoans)
          .where(
            and(
              eq(salaryLoans.orgId, orgId),
              inArray(salaryLoans.userId, reportIds),
              eq(salaryLoans.status, "PENDING"),
            ),
          )
          .orderBy(desc(salaryLoans.createdAt))
          .limit(50),
      ]);

    const reimbByUser = new Map(reimbRows.map((r) => [r.userId, Number(r.total)]));
    const loanByUser = new Map(loanRows.map((r) => [r.userId, Number(r.total)]));

    const latestPayslipByUser = new Map<
      string,
      { month: string; net: string | null; publicationId: number }
    >();
    for (const p of pubs) {
      if (!latestPayslipByUser.has(p.userId)) {
        latestPayslipByUser.set(p.userId, {
          month: p.month,
          net: p.net,
          publicationId: p.publicationId,
        });
      }
    }

    const taxByUser = new Map<string, string>();
    for (const t of taxRows) {
      if (!taxByUser.has(t.userId)) taxByUser.set(t.userId, t.status);
    }

    const members: ManagerTeamMember[] = reports.map((r) => {
      const pendingReimbursements = reimbByUser.get(r.id) ?? 0;
      const pendingLoans = loanByUser.get(r.id) ?? 0;
      const taxDeclarationStatus = taxByUser.get(r.id) ?? null;
      const taxNeedsReview = taxDeclarationStatus === "SUBMITTED";
      const actionCount =
        pendingReimbursements + pendingLoans + (taxNeedsReview ? 1 : 0);
      return {
        userId: r.id,
        name: r.name,
        email: r.email,
        pendingReimbursements,
        pendingLoans,
        latestPayslip: latestPayslipByUser.get(r.id) ?? null,
        taxDeclarationStatus,
        actionCount,
      };
    });

    members.sort(
      (a, b) => b.actionCount - a.actionCount || (a.name ?? "").localeCompare(b.name ?? ""),
    );

    const pendingReimbursements: ManagerPendingReimbursement[] = pendingReimbList.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: nameByUser.get(r.userId) ?? null,
      category: r.category,
      amount: r.amount,
      description: r.description,
      createdAt: r.createdAt,
    }));

    const pendingLoans: ManagerPendingLoan[] = pendingLoanList.map((l) => ({
      id: l.id,
      userId: l.userId,
      userName: nameByUser.get(l.userId) ?? null,
      amount: l.amount,
      reason: l.reason,
      totalEmis: l.totalEmis,
      createdAt: l.createdAt,
    }));

    const totals = {
      pendingReimbursements: members.reduce((s, m) => s + m.pendingReimbursements, 0),
      pendingLoans: members.reduce((s, m) => s + m.pendingLoans, 0),
      membersNeedingAction: members.filter((m) => m.actionCount > 0).length,
    };

    return {
      mode: "manager_self_service",
      honestyNote,
      reportCount: members.length,
      canApproveReimbursements,
      canApproveLoans,
      members,
      pendingReimbursements,
      pendingLoans,
      totals,
    };
  }

  async approveReimbursement(
    orgId: string,
    managerUserId: string,
    reimbursementId: number,
  ): Promise<{ success: true }> {
    await this.assertCanApproveReimbursements(orgId, managerUserId);
    const row = await this.requirePendingReimbursementForReport(
      orgId,
      managerUserId,
      reimbursementId,
    );
    if (row.userId === managerUserId) {
      throw new ForbiddenException("You cannot approve your own reimbursement.");
    }
    const result = await this.reimbursements.updateStatus(orgId, managerUserId, reimbursementId, {
      status: "APPROVED",
    });
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Reimbursement not found");
      throw new ForbiddenException("You cannot approve this reimbursement");
    }
    return { success: true };
  }

  async rejectReimbursement(
    orgId: string,
    managerUserId: string,
    reimbursementId: number,
    reason?: string,
  ): Promise<{ success: true }> {
    await this.assertCanApproveReimbursements(orgId, managerUserId);
    await this.requirePendingReimbursementForReport(orgId, managerUserId, reimbursementId);
    const result = await this.reimbursements.updateStatus(orgId, managerUserId, reimbursementId, {
      status: "REJECTED",
      rejectionReason: reason?.trim() || "Rejected by manager",
    });
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Reimbursement not found");
      throw new ForbiddenException("You cannot reject this reimbursement");
    }
    return { success: true };
  }

  async approveLoan(
    orgId: string,
    managerUserId: string,
    loanId: number,
  ): Promise<{ success: true }> {
    await this.assertCanApproveLoans(orgId, managerUserId);
    await this.requirePendingLoanForReport(orgId, managerUserId, loanId);
    const result = await this.loans.updateLoan(orgId, managerUserId, loanId, {
      status: "APPROVED",
    });
    if (!result.ok) throw new NotFoundException("Loan not found");
    return { success: true };
  }

  async rejectLoan(
    orgId: string,
    managerUserId: string,
    loanId: number,
  ): Promise<{ success: true }> {
    await this.assertCanApproveLoans(orgId, managerUserId);
    await this.requirePendingLoanForReport(orgId, managerUserId, loanId);
    const result = await this.loans.updateLoan(orgId, managerUserId, loanId, {
      status: "REJECTED",
    });
    if (!result.ok) throw new NotFoundException("Loan not found");
    return { success: true };
  }

  private async assertCanApproveReimbursements(orgId: string, userId: string): Promise<void> {
    const perms = await this.access.resolveUserPermissions(orgId, userId);
    if (!perms.has("hr:expenses:approve")) {
      throw new ForbiddenException(
        "Missing permission hr:expenses:approve to approve team reimbursements",
      );
    }
  }

  private async assertCanApproveLoans(orgId: string, userId: string): Promise<void> {
    const perms = await this.access.resolveUserPermissions(orgId, userId);
    if (!perms.has("hr:expenses:approve") && !perms.has("hr:loans:manage")) {
      throw new ForbiddenException(
        "Missing permission hr:expenses:approve or hr:loans:manage to process team loans",
      );
    }
  }

  private async requirePendingReimbursementForReport(
    orgId: string,
    managerUserId: string,
    reimbursementId: number,
  ) {
    const row = await this.db.query.reimbursements.findFirst({
      where: and(eq(reimbursements.id, reimbursementId), eq(reimbursements.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Reimbursement not found");
    if (row.status !== "PENDING") {
      throw new BadRequestException(`Reimbursement is ${row.status}, not PENDING`);
    }
    await this.assertIsDirectReport(managerUserId, row.userId);
    return row;
  }

  private async requirePendingLoanForReport(
    orgId: string,
    managerUserId: string,
    loanId: number,
  ) {
    const row = await this.db.query.salaryLoans.findFirst({
      where: and(eq(salaryLoans.id, loanId), eq(salaryLoans.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Loan not found");
    if (row.status !== "PENDING") {
      throw new BadRequestException(`Loan is ${row.status}, not PENDING`);
    }
    await this.assertIsDirectReport(managerUserId, row.userId);
    return row;
  }

  private async assertIsDirectReport(managerUserId: string, subjectUserId: string): Promise<void> {
    const subject = await this.db.query.users.findFirst({
      where: eq(users.id, subjectUserId),
      columns: { reportingTo: true },
    });
    if (!subject || subject.reportingTo !== managerUserId) {
      throw new ForbiddenException(
        "You can only act on requests from your direct reports",
      );
    }
  }
}
