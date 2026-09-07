import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  accountingSettings,
  accNumberSequences,
  accSystemAccountMap,
  accountingPeriods,
  journalEntries,
  ledgerAccounts,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { SETTINGS_CACHE_KEY, SETUP_STATUS_CACHE_KEY, SEQUENCE_DEFAULTS } from "./accounting-settings.constants";
import type { UpdateSettingsInput, UpdateSequenceInput, SequenceEntityType, UpsertPaymentTermsInput } from "./dto/settings.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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

    if (!created) throw new Error("Insert into accounting_settings returned no row");
    return created;
  }

  async getSettings(orgId: string) {
    return this.cache.cached(SETTINGS_CACHE_KEY(orgId), () => this.getOrCreateSettings(orgId), 300);
  }

  async updateSettings(u: CurrentUserContext, input: UpdateSettingsInput) {
    const current = await this.getOrCreateSettings(u.orgId);

    if (input.baseCurrency && input.baseCurrency !== current.baseCurrency) {
      const posted = await this.db
        .select({ one: sql`1` })
        .from(journalEntries)
        .where(and(eq(journalEntries.orgId, u.orgId), eq(journalEntries.status, "POSTED")))
        .limit(1);

      if (posted.length > 0) {
        throw new ConflictException("Cannot change base currency after posting journals");
      }
    }

    const updated = await this.db
      .update(accountingSettings)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(accountingSettings.orgId, u.orgId))
      .returning();

    await Promise.all([
      this.cache.invalidate(SETTINGS_CACHE_KEY(u.orgId)),
      this.cache.invalidate(SETUP_STATUS_CACHE_KEY(u.orgId)),
    ]);

    this.audit.log({
      action: "accounting.settings.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "accounting_settings",
      resourceId: u.orgId,
      before: {
        baseCurrency: current.baseCurrency,
        fiscalYearStartMonth: current.fiscalYearStartMonth,
        accountingBasis: current.accountingBasis,
      },
      after: { ...input },
    });

    const [row] = updated;
    if (!row) throw new NotFoundException("Accounting settings not found");
    return row;
  }

  async getSetupStatus(orgId: string) {
    return this.cache.cached(SETUP_STATUS_CACHE_KEY(orgId), () => this.fetchSetupStatus(orgId), 60);
  }

  private async fetchSetupStatus(orgId: string) {
    const TOTAL_PURPOSES = 16;

    const [settings, anyAccount, [systemMappedCount], [openingBalanceEntry], anyPeriod] =
      await Promise.all([
        this.getOrCreateSettings(orgId),
        this.db
          .select({ one: sql`1` })
          .from(ledgerAccounts)
          .where(eq(ledgerAccounts.orgId, orgId))
          .limit(1),
        this.db
          .select({ total: count() })
          .from(accSystemAccountMap)
          .where(eq(accSystemAccountMap.orgId, orgId)),
        this.db
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.sourceType, "OPENING_BALANCE")))
          .limit(1),
        this.db
          .select({ one: sql`1` })
          .from(accountingPeriods)
          .where(eq(accountingPeriods.orgId, orgId))
          .limit(1),
      ]);

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
        done: anyAccount.length > 0,
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
        done: anyPeriod.length > 0,
      },
    ];

    return { steps };
  }

  async listSequences(orgId: string) {
    const rows = await this.db
      .select()
      .from(accNumberSequences)
      .where(eq(accNumberSequences.orgId, orgId))
      .limit(100);

    const byType = new Map(rows.map((r) => [r.entityType, r]));
    const all = Object.entries(SEQUENCE_DEFAULTS).map(([entityType, defaults]) => {
      const existing = byType.get(entityType);
      if (existing) return existing;
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

  async updatePaymentTerms(u: CurrentUserContext, input: UpsertPaymentTermsInput) {
    await this.getOrCreateSettings(u.orgId);

    const [updated] = await this.db
      .update(accountingSettings)
      .set({ paymentTerms: input.terms, updatedAt: new Date() })
      .where(eq(accountingSettings.orgId, u.orgId))
      .returning();

    await this.cache.invalidate(SETTINGS_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.settings.payment_terms_updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "accounting_settings",
      resourceId: u.orgId,
      after: { terms: input.terms },
    });

    if (!updated) throw new NotFoundException("Accounting settings not found");
    return updated;
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
      if (!updated) throw new NotFoundException("Number sequence not found");
      result = updated;
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
      if (!created) throw new Error("Insert into acc_number_sequences returned no row");
      result = created;
    }

    this.audit.log({
      action: "accounting.sequence.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "acc_number_sequence",
      resourceId: entityType,
      after: { ...input },
    });

    return result;
  }
}
