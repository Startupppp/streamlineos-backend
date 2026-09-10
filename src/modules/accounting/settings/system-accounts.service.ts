import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { accSystemAccountMap, ledgerAccounts } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { SETTINGS_CACHE_KEY, PURPOSE_ALLOWED_TYPES, PURPOSE_SUGGESTED_CODE } from "./accounting-settings.constants";
import { systemAccountPurposeSchema } from "./dto/settings.schemas";
import type { SystemAccountPurpose, UpsertSystemAccountInput } from "./dto/settings.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/**
 * Every purpose the settings screen offers, taken from the schema rather than
 * retyped beside it.
 *
 * This was a hand-kept copy of `systemAccountPurposeSchema`'s list, and it is
 * the one copy of the four that the compiler could not check.
 * `PURPOSE_ALLOWED_TYPES` and `PURPOSE_SUGGESTED_CODE` are
 * `Record<SystemAccountPurpose, …>`, so a new purpose breaks the build until
 * they are updated; the pgEnum is held to the schema by
 * `system-account-purposes.spec`. A plain array is neither. Omitting a purpose
 * here compiled cleanly and simply removed it from the admin's list — the
 * mapping would still be honoured everywhere it was read, so the account would
 * go on working with no way left to change it.
 *
 * `.options` is the schema's own tuple, so the list cannot fall behind again.
 */
const ALL_PURPOSES: readonly SystemAccountPurpose[] = systemAccountPurposeSchema.options;

@Injectable()
export class SystemAccountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listSystemAccounts(orgId: string) {
    const mapped = await this.db
      .select({
        purpose: accSystemAccountMap.purpose,
        accountId: accSystemAccountMap.accountId,
        accountCode: ledgerAccounts.code,
        accountName: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
      })
      .from(accSystemAccountMap)
      .innerJoin(ledgerAccounts, eq(accSystemAccountMap.accountId, ledgerAccounts.id))
      .where(eq(accSystemAccountMap.orgId, orgId))
      .limit(100);

    const mappedByPurpose = new Map(mapped.map((r) => [r.purpose, r]));

    const accountCodes = ALL_PURPOSES
      .filter((p) => !mappedByPurpose.has(p))
      .map((p) => PURPOSE_SUGGESTED_CODE[p])
      .filter((c): c is string => !!c);

    let suggestedAccounts: Array<{ code: string; id: number; name: string; accountType: string }> = [];
    if (accountCodes.length > 0) {
      suggestedAccounts = await this.db
        .select({ code: ledgerAccounts.code, id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.orgId, orgId), inArray(ledgerAccounts.code, accountCodes)));
    }

    const suggestedByCode = new Map(suggestedAccounts.map((a) => [a.code, a]));

    return ALL_PURPOSES.map((purpose) => {
      const existing = mappedByPurpose.get(purpose);
      if (existing) {
        return {
          purpose,
          mapped: true,
          accountId: existing.accountId,
          accountCode: existing.accountCode,
          accountName: existing.accountName,
          accountType: existing.accountType,
          suggestedAccountId: null,
          suggestedAccountCode: null,
          suggestedAccountName: null,
        };
      }

      const sugCode = PURPOSE_SUGGESTED_CODE[purpose];
      const sug = sugCode ? suggestedByCode.get(sugCode) : undefined;

      return {
        purpose,
        mapped: false,
        accountId: null,
        accountCode: null,
        accountName: null,
        accountType: null,
        suggestedAccountId: sug?.id ?? null,
        suggestedAccountCode: sug?.code ?? null,
        suggestedAccountName: sug?.name ?? null,
      };
    });
  }

  async upsertSystemAccount(u: CurrentUserContext, purpose: SystemAccountPurpose, input: UpsertSystemAccountInput) {
    const [account] = await this.db
      .select({ id: ledgerAccounts.id, accountType: ledgerAccounts.accountType, orgId: ledgerAccounts.orgId })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, input.accountId), eq(ledgerAccounts.orgId, u.orgId)))
      .limit(1);

    if (!account) {
      throw new NotFoundException(`Account ${input.accountId} not found`);
    }

    const allowed = PURPOSE_ALLOWED_TYPES[purpose];
    if (!allowed.includes(account.accountType)) {
      throw new UnprocessableEntityException(
        `Account type ${account.accountType} is not valid for purpose ${purpose}. Allowed: ${allowed.join(", ")}`,
      );
    }

    await this.db
      .insert(accSystemAccountMap)
      .values({ orgId: u.orgId, purpose, accountId: input.accountId })
      .onConflictDoUpdate({
        target: [accSystemAccountMap.orgId, accSystemAccountMap.purpose],
        set: { accountId: input.accountId, updatedAt: new Date() },
      });

    await this.cache.invalidate(SETTINGS_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.system_account.mapped",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "acc_system_account_map",
      resourceId: purpose,
      after: { purpose, accountId: input.accountId },
    });

    return { purpose, accountId: input.accountId };
  }
}
