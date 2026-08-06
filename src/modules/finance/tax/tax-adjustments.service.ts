import { BadRequestException, Injectable } from "@nestjs/common";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import type { CreateTaxAdjustmentInput } from "./dto/tax-adjustments.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { PostJournalLine } from "../../accounting/core/finance-posting.types";

@Injectable()
export class TaxAdjustmentsService {
  constructor(
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly posting: FinancePostingService,
  ) {}

  async createAdjustment(u: CurrentUserContext, input: CreateTaxAdjustmentInput) {
    const { orgId, userId } = u;

    const totalDebit = input.lines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
    const totalCredit = input.lines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.001) {
      throw new BadRequestException(`Adjustment lines must balance: debits (${totalDebit}) != credits (${totalCredit})`);
    }

    const journalLines: PostJournalLine[] = input.lines.map((line) => {
      if (line.systemPurpose) {
        return {
          systemPurpose: line.systemPurpose,
          debit: line.debit,
          credit: line.credit,
          description: line.description,
        };
      }
      return {
        accountId: line.accountId,
        debit: line.debit,
        credit: line.credit,
        description: line.description,
      };
    });

    const sourceId = `${orgId}:adj:${input.entryDate}:${Date.now()}`;

    const result = await this.posting.postJournal(u, {
      entryDate: input.entryDate,
      description: input.description,
      sourceType: "TAX_ADJUSTMENT",
      sourceId,
      sourceEvent: "create",
      lines: journalLines,
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.finTaxDashboardNamespace(orgId));
    await this.cache.invalidateNamespace(CACHE_KEYS.finTaxReportsNamespace(orgId));

    this.audit.log({
      action: "accounting.tax_adjustment.create",
      userId,
      orgId,
      resourceType: "journal_entry",
      resourceId: String(result.entryId),
      metadata: { entryNumber: result.entryNumber, description: input.description, lineCount: input.lines.length },
      result: "SUCCESS",
    });

    return { entryId: result.entryId, entryNumber: result.entryNumber };
  }
}
