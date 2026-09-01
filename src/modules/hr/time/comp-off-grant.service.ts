import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  leaveBalances,
  leaveTypes,
  organizationMembers,
} from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { DEFAULT_COMP_OFF_MAX_ACCRUAL } from "../policies/hr-policy-defaults.constants";
import type { CompOffInput } from "./dto/leaves.schemas";
import { LeaveLedgerService } from "./leave-ledger.service";

const COMP_OFF_LEAVE_TYPE_NAME = "Compensatory Off";
const COMP_OFF_GRANT_PERMISSION = "hr:leaves:manage";

@Injectable()
export class CompOffGrantService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    @Optional() private readonly policyEval: HrPolicyEvaluationService,
    @Optional() private readonly ledger: LeaveLedgerService,
  ) {}

  async grant(currentUser: CurrentUserContext, input: CompOffInput) {
    const permissions = await this.access.resolveUserPermissions(
      currentUser.orgId,
      currentUser.userId,
    );
    if (!permissions.has(COMP_OFF_GRANT_PERMISSION)) {
      throw new ForbiddenException("You do not have permission to grant comp-off.");
    }

    const maxAccrual = await this.resolveMaxAccrual(currentUser.orgId, input.userId);
    const result = await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ userId: organizationMembers.userId, membershipId: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, currentUser.orgId),
            eq(organizationMembers.userId, input.userId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(1);
      if (!target) throw new NotFoundException("Employee not found.");

      let compOffType = await tx.query.leaveTypes.findFirst({
        where: and(
          eq(leaveTypes.orgId, currentUser.orgId),
          eq(leaveTypes.name, COMP_OFF_LEAVE_TYPE_NAME),
        ),
      });
      if (!compOffType) {
        const [created] = await tx
          .insert(leaveTypes)
          .values({
            orgId: currentUser.orgId,
            name: COMP_OFF_LEAVE_TYPE_NAME,
            daysPerYear: maxAccrual,
            carryForward: false,
          })
          .onConflictDoNothing()
          .returning();
        compOffType =
          created ??
          (await tx.query.leaveTypes.findFirst({
            where: and(
              eq(leaveTypes.orgId, currentUser.orgId),
              eq(leaveTypes.name, COMP_OFF_LEAVE_TYPE_NAME),
            ),
          }));
      }
      if (!compOffType) {
        throw new InternalServerErrorException(
          "Failed to find or create the comp-off leave type.",
        );
      }

      const [existing] = await tx
        .select({ id: leaveBalances.id, balance: leaveBalances.balance })
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.orgId, currentUser.orgId),
            eq(leaveBalances.userMembershipId, target.membershipId),
            eq(leaveBalances.leaveTypeId, compOffType.id),
            eq(leaveBalances.year, new Date().getFullYear()),
          ),
        )
        .for("update")
        .limit(1);

      if (existing) {
        await tx
          .update(leaveBalances)
          .set({ balance: String(Number(existing.balance) + input.days) })
          .where(
            and(
              eq(leaveBalances.id, existing.id),
              eq(leaveBalances.orgId, currentUser.orgId),
            ),
          );
      } else {
        await tx.insert(leaveBalances).values({
          orgId: currentUser.orgId,
          userId: input.userId,
          userMembershipId: target.membershipId,
          leaveTypeId: compOffType.id,
          balance: String(input.days),
          year: new Date().getFullYear(),
        });
      }

      if (this.ledger) {
        await this.ledger.write(
          {
            orgId: currentUser.orgId,
            userId: input.userId,
            leaveTypeId: compOffType.id,
            txnType: "comp_off_earn",
            days: input.days,
            effectiveDate: new Date().toISOString().slice(0, 10),
            source: "manual",
            note: input.reason?.trim() || "Comp-off granted by an administrator",
            createdBy: currentUser.userId,
          },
          tx,
        );
      }

      await this.audit.logCritical({
        action: "hr.comp_off_granted",
        userId: currentUser.userId,
        orgId: currentUser.orgId,
        targetId: input.userId,
        targetType: "employee",
        metadata: { days: input.days, leaveTypeId: compOffType.id },
      });

      return { leaveTypeId: compOffType.id };
    });

    return { success: true, credited: input.days, ...result };
  }

  private async resolveMaxAccrual(
    orgId: string,
    userId: string,
  ): Promise<number> {
    if (!this.policyEval) return DEFAULT_COMP_OFF_MAX_ACCRUAL;
    try {
      const result = await this.policyEval.evaluatePolicy(
        orgId,
        userId,
        "comp_off",
        new Date().toISOString().slice(0, 10),
      );
      const rules = result?.rules as Record<string, unknown> | undefined;
      return typeof rules?.["maxAccrual"] === "number"
        ? rules["maxAccrual"]
        : DEFAULT_COMP_OFF_MAX_ACCRUAL;
    } catch {
      return DEFAULT_COMP_OFF_MAX_ACCRUAL;
    }
  }
}
