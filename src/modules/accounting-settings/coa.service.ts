import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, exists, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { accSystemAccountMap, journalLines, ledgerAccounts } from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { COA_TREE_CACHE_KEY, SETTINGS_CACHE_KEY } from "./accounting-settings.constants";
import { COA_TEMPLATES } from "./coa-templates.constants";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

interface AccountTreeNode {
  id: number;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string | null;
  isSystem: boolean;
  isActive: boolean;
  description: string | null;
  parentAccountId: number | null;
  hasActivity: boolean;
  children: AccountTreeNode[];
}

@Injectable()
export class CoaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async getTree(orgId: string) {
    return this.cache.cached(
      COA_TREE_CACHE_KEY(orgId),
      async () => {
        const rows = await this.db
          .select({
            id: ledgerAccounts.id,
            code: ledgerAccounts.code,
            name: ledgerAccounts.name,
            accountType: ledgerAccounts.accountType,
            normalBalance: ledgerAccounts.normalBalance,
            isSystem: ledgerAccounts.isSystem,
            isActive: ledgerAccounts.isActive,
            description: ledgerAccounts.description,
            parentAccountId: ledgerAccounts.parentAccountId,
            hasActivity: exists(
              this.db
                .select({ one: sql`1` })
                .from(journalLines)
                .where(and(
                  eq(journalLines.accountId, ledgerAccounts.id),
                  eq(journalLines.orgId, ledgerAccounts.orgId),
                )),
            ),
          })
          .from(ledgerAccounts)
          .where(eq(ledgerAccounts.orgId, orgId))
          .orderBy(ledgerAccounts.code);

        const nodeMap = new Map<number, AccountTreeNode>();
        for (const row of rows) {
          nodeMap.set(row.id, {
            id: row.id,
            code: row.code,
            name: row.name,
            accountType: row.accountType,
            normalBalance: row.normalBalance,
            isSystem: row.isSystem,
            isActive: row.isActive,
            description: row.description,
            parentAccountId: row.parentAccountId,
            hasActivity: Boolean(row.hasActivity),
            children: [],
          });
        }

        const roots: AccountTreeNode[] = [];
        for (const node of nodeMap.values()) {
          if (node.parentAccountId !== null) {
            const parent = nodeMap.get(node.parentAccountId);
            if (parent) {
              parent.children.push(node);
              continue;
            }
          }
          roots.push(node);
        }

        return { items: roots };
      },
      120,
    );
  }

  async deactivateAccount(u: CurrentUserContext, accountId: number) {
    const [account] = await this.db
      .select({ id: ledgerAccounts.id, isActive: ledgerAccounts.isActive, orgId: ledgerAccounts.orgId })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.orgId, u.orgId)))
      .limit(1);

    if (!account) throw new NotFoundException(`Account ${accountId} not found`);

    const [systemMapping] = await this.db
      .select({ purpose: accSystemAccountMap.purpose })
      .from(accSystemAccountMap)
      .where(and(eq(accSystemAccountMap.orgId, u.orgId), eq(accSystemAccountMap.accountId, accountId)))
      .limit(1);

    if (systemMapping) {
      throw new ConflictException(
        `Cannot deactivate account mapped to system purpose: ${systemMapping.purpose}`,
      );
    }

    await this.db
      .update(ledgerAccounts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.orgId, u.orgId)));

    await this.cache.invalidate(COA_TREE_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.account.deactivated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "ledger_account",
      resourceId: String(accountId),
    });

    return { id: accountId, isActive: false };
  }

  async activateAccount(u: CurrentUserContext, accountId: number) {
    const [account] = await this.db
      .select({ id: ledgerAccounts.id, orgId: ledgerAccounts.orgId })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.orgId, u.orgId)))
      .limit(1);

    if (!account) throw new NotFoundException(`Account ${accountId} not found`);

    await this.db
      .update(ledgerAccounts)
      .set({ isActive: true, updatedAt: new Date() })
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.orgId, u.orgId)));

    await this.cache.invalidate(COA_TREE_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.account.activated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "ledger_account",
      resourceId: String(accountId),
    });

    return { id: accountId, isActive: true };
  }

  async deleteAccount(u: CurrentUserContext, accountId: number) {
    const [account] = await this.db
      .select({ id: ledgerAccounts.id, orgId: ledgerAccounts.orgId })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.orgId, u.orgId)))
      .limit(1);

    if (!account) throw new NotFoundException(`Account ${accountId} not found`);

    const [lineRef] = await this.db
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(eq(journalLines.accountId, accountId))
      .limit(1);

    if (lineRef) {
      throw new ConflictException("Cannot delete account with journal entries. Deactivate it instead.");
    }

    await this.db
      .update(ledgerAccounts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.orgId, u.orgId)));

    await this.cache.invalidate(COA_TREE_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.account.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "ledger_account",
      resourceId: String(accountId),
    });

    return { id: accountId, isActive: false };
  }

  getTemplates() {
    return {
      items: COA_TEMPLATES.map((t) => ({
        key: t.key,
        label: t.label,
        country: t.country,
        accountCount: t.accounts.length,
      })),
    };
  }

  async applyTemplate(u: CurrentUserContext, templateKey: string) {
    const template = COA_TEMPLATES.find((t) => t.key === templateKey);
    if (!template) throw new NotFoundException(`Template '${templateKey}' not found`);

    const existing = await this.db
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.orgId, u.orgId));

    const existingCodes = new Set(existing.map((r) => r.code));
    const toInsert = template.accounts.filter((a) => !existingCodes.has(a.code));

    if (toInsert.length > 0) {
      await this.db.insert(ledgerAccounts).values(
        toInsert.map((a) => ({
          orgId: u.orgId,
          code: a.code,
          name: a.name,
          accountType: a.accountType,
          normalBalance: a.normalBalance ?? null,
          isSystem: a.isSystem ?? false,
          description: a.description ?? null,
        })),
      );
    }

    await this.cache.invalidate(COA_TREE_CACHE_KEY(u.orgId));
    await this.cache.invalidate(SETTINGS_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.coa.template_applied",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "ledger_account",
      resourceId: templateKey,
      after: { inserted: toInsert.length, skipped: existingCodes.size } as Record<string, unknown>,
    });

    return {
      templateKey,
      inserted: toInsert.length,
      skipped: existing.length,
    };
  }
}
