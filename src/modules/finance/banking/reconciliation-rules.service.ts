import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { finBankAccounts, finReconciliationRules } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import {
  paginateOffset,
  buildListResponse,
} from "../../../common/pagination/pagination";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateReconciliationRuleInput } from "./dto/reconciliation.schemas";

interface RulesQuery {
  page: number;
  pageSize: number;
  bankAccountId?: number;
}

@Injectable()
export class ReconciliationRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listRules(u: CurrentUserContext, query: RulesQuery) {
    const { orgId } = u;
    const { limit, offset } = paginateOffset(query);

    const where = eq(finReconciliationRules.orgId, orgId);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(finReconciliationRules)
        .where(where)
        .orderBy(sql`${finReconciliationRules.priority} DESC`)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(finReconciliationRules)
        .where(where),
    ]);

    return buildListResponse(rows, totals?.total ?? 0, query);
  }

  async createRule(
    u: CurrentUserContext,
    bankAccountId: number,
    input: CreateReconciliationRuleInput,
  ) {
    const { orgId, userId } = u;

    await this.assertAccountOwned(orgId, bankAccountId);

    const [rule] = await this.db
      .insert(finReconciliationRules)
      .values({
        orgId,
        name: input.name,
        priority: input.priority,
        conditions: input.conditions,
        action: input.action,
        isActive: input.isActive,
      })
      .returning();

    if (!rule) throw new Error("Failed to create reconciliation rule");

    this.audit.log({
      action: "banking.rule.create",
      userId,
      orgId,
      resourceType: "reconciliation_rule",
      resourceId: String(rule.id),
      result: "SUCCESS",
    });

    return rule;
  }

  async deleteRule(
    u: CurrentUserContext,
    bankAccountId: number,
    ruleId: number,
  ) {
    const { orgId, userId } = u;

    await this.assertAccountOwned(orgId, bankAccountId);

    const existing = await this.db.query.finReconciliationRules.findFirst({
      where: and(
        eq(finReconciliationRules.id, ruleId),
        eq(finReconciliationRules.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Reconciliation rule not found");

    await this.db
      .delete(finReconciliationRules)
      .where(
        and(
          eq(finReconciliationRules.id, ruleId),
          eq(finReconciliationRules.orgId, orgId),
        ),
      );

    this.audit.log({
      action: "banking.rule.delete",
      userId,
      orgId,
      resourceType: "reconciliation_rule",
      resourceId: String(ruleId),
      result: "SUCCESS",
    });

    return { success: true };
  }

  private async assertAccountOwned(
    orgId: string,
    bankAccountId: number,
  ): Promise<void> {
    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(
        eq(finBankAccounts.id, bankAccountId),
        eq(finBankAccounts.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!account) throw new NotFoundException("Bank account not found");
  }
}
