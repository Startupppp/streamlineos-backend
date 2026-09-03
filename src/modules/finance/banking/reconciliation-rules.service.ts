import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { finBankAccounts, finReconciliationRules } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeValue } from "../../../common/pagination/keyset";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateReconciliationRuleInput } from "./dto/reconciliation.schemas";

interface RulesQuery {
  cursor?: string;
  limit: number;
  bankAccountId?: number;
}

@Injectable()
export class ReconciliationRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listRules(u: CurrentUserContext, query: RulesQuery): Promise<CursorPage<typeof finReconciliationRules.$inferSelect>> {
    const { orgId } = u;
    /**
     * `fin_reconciliation_rules` carries no `bank_account_id` — the rules are org-wide — so the
     * account in the path selects nothing and used to be dropped on the floor. The route still
     * ADDRESSES an account, and a route that never resolves the object it addresses answers
     * another organization's bank account id exactly as it answers its own: 200, with this org's
     * rules. Cross-tenant that discloses nothing, but the 404 the contract requires is absent, and
     * `createRule`/`deleteRule` on the same controller already assert the account. Assert it here
     * too, so all three verbs on `/finance/reconciliation/:bankAccountId/*` agree.
     */
    if (query.bankAccountId !== undefined) await this.assertAccountOwned(orgId, query.bankAccountId);
    const pos = decodeCursor(query.cursor);

    const conditions = [eq(finReconciliationRules.orgId, orgId)];
    if (pos) conditions.push(keysetBeforeValue(finReconciliationRules.priority, finReconciliationRules.id, pos));

    const rows = await this.db
      .select()
      .from(finReconciliationRules)
      .where(and(...conditions))
      .orderBy(desc(finReconciliationRules.priority), desc(finReconciliationRules.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (r) => ({
      sortValue: String(r.priority),
      id: String(r.id),
    }));
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
