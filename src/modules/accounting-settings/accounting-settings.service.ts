import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  accountingSettings,
  accNumberSequences,
  accSystemAccountMap,
  accountingPeriods,
  journalEntries,
  ledgerAccounts,
} from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { SETTINGS_CACHE_KEY, COA_TREE_CACHE_KEY, PURPOSE_ALLOWED_TYPES, SEQUENCE_DEFAULTS } from "./accounting-settings.constants";
import type { UpdateSettingsInput, UpdateSequenceInput, SequenceEntityType } from "./dto/settings.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@Injectable()
export class AccountingSettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async getOrCreateSettings(orgId: string) {
    const existing = await this.db
      .select()
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);

    if (existing[0]) return existing[0];

    const [created] = await this.db
      .insert(accountingSettings)
      .values({ orgId, baseCurrency: "INR", fiscalYearStartMonth: 4, accountingBasis: "ACCRUAL" })
      .returning();

    return created!;
  }

  async getSettings(orgId: string) {
    return this.cache.cached(SETTINGS_CACHE_KEY(orgId), () => this.getOrCreateSettings(orgId), 300);
  }

  async updateSettings(u: CurrentUserContext, input: UpdateSettingsInput) {
    const current = await this.getOrCreateSettings(u.orgId);

    if (input.baseCurrency && input.baseCurrency !== current.baseCurrency) {
      const [journalCount] = await this.db
        .select({ total: count() })
        .from(journalEntries)
        .where(and(eq(journalEntries.orgId, u.orgId), eq(journalEntries.status, "POSTED")));

      if ((journalCount?.total ?? 0) > 0) {
        throw new ConflictException("Cannot change base currency after posting journals");
      }
    }

    const updated = await this.db
      .update(accountingSettings)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(accountingSettings.orgId, u.orgId))
      .returning();

    await this.cache.invalidate(SETTINGS_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.settings.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "accounting_settings",
      resourceId: u.orgId,
      before: current as unknown as Record<string, unknown>,
      after: input as unknown as Record<string, unknown>,
    });

    return updated[0]!;
  }

  async getSetupStatus(orgId: string) {
    const settings = await this.getOrCreateSettings(orgId);

    const [accountCount] = await this.db
      .select({ total: count() })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.orgId, orgId));

    const [systemMappedCount] = await this.db
      .select({ total: count() })
      .from(accSystemAccountMap)
      .where(eq(accSystemAccountMap.orgId, orgId));

    const [openingBalanceEntry] = await this.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.sourceType, "OPENING_BALANCE")))
      .limit(1);

    const [periodCount] = await this.db
      .select({ total: count() })
      .from(accountingPeriods)
      .where(eq(accountingPeriods.orgId, orgId));

    const TOTAL_PURPOSES = 16;

    const steps = [
      {
        key: "settings",
        label: "Configure accounting settings",
        done: !!settings.baseCurrency && !!settings.accountingBasis,
      },
      {
        key: "tax_registration",
        label: "Set tax registration details",
        done: !!settings.taxRegistration,
      },
      {
        key: "coa",
        label: "Set up chart of accounts",
        done: (accountCount?.total ?? 0) > 0,
      },
      {
        key: "system_accounts",
        label: "Map system accounts",
        done: (systemMappedCount?.total ?? 0) >= TOTAL_PURPOSES,
      },
      {
        key: "opening_balances",
        label: "Post opening balances",
        done: !!openingBalanceEntry,
      },
      {
        key: "periods",
        label: "Create accounting periods",
        done: (periodCount?.total ?? 0) > 0,
      },
    ];

    return { steps };
  }

  async listSequences(orgId: string) {
    const rows = await this.db
      .select()
      .from(accNumberSequences)
      .where(eq(accNumberSequences.orgId, orgId));

    const byType = new Map(rows.map((r) => [r.entityType, r]));
    const all = Object.keys(SEQUENCE_DEFAULTS).map((entityType) => {
      const existing = byType.get(entityType);
      if (existing) return existing;
      const defaults = SEQUENCE_DEFAULTS[entityType]!;
      return {
        id: null,
        orgId,
        entityType,
        prefix: defaults.prefix,
        padding: defaults.padding,
        nextNumber: 1,
        createdAt: null,
      };
    });

    return { items: all };
  }

  async updateSequence(u: CurrentUserContext, entityType: SequenceEntityType, input: UpdateSequenceInput) {
    const existing = await this.db
      .select()
      .from(accNumberSequences)
      .where(and(eq(accNumberSequences.orgId, u.orgId), eq(accNumberSequences.entityType, entityType)))
      .limit(1);

    let result;

    if (existing[0]) {
      const [updated] = await this.db
        .update(accNumberSequences)
        .set({ ...input })
        .where(and(eq(accNumberSequences.orgId, u.orgId), eq(accNumberSequences.entityType, entityType)))
        .returning();
      result = updated!;
    } else {
      const defaults = SEQUENCE_DEFAULTS[entityType];
      const [created] = await this.db
        .insert(accNumberSequences)
        .values({
          orgId: u.orgId,
          entityType,
          prefix: input.prefix ?? defaults?.prefix ?? entityType.toUpperCase(),
          padding: input.padding ?? defaults?.padding ?? 5,
          nextNumber: input.nextNumber ?? 1,
        })
        .returning();
      result = created!;
    }

    this.audit.log({
      action: "accounting.sequence.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "acc_number_sequence",
      resourceId: entityType,
      after: input as unknown as Record<string, unknown>,
    });

    return result;
  }
}
