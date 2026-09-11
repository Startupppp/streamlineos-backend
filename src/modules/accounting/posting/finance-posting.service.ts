import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  journalEntries,
  accountingPeriods,
  accountingSettings,
  accNumberSequences,
  finApprovalRequests,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  PostJournalInput,
  PostJournalResult,
  ReverseJournalResult,
  SystemAccountPurpose,
} from "../core/finance-posting.types";
import { FinancePostingAccountsService } from "./finance-posting-accounts.service";
import { postJournal, type JournalPostDeps } from "./lib/journal-post";
import { reverseJournal, type JournalReverseDeps } from "./lib/journal-reverse";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

function yyyymm(dateIso: string): string {
  return dateIso.slice(0, 7).replace("-", "");
}

@Injectable()
export class FinancePostingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly accounts: FinancePostingAccountsService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly cache: CacheService,
  ) {}

  private get postDeps(): JournalPostDeps {
    return {
      db: this.db,
      accounts: this.accounts,
      audit: this.audit,
      dispatch: this.dispatch,
      cache: this.cache,
      assertPeriodOpen: (orgId, date) => this.assertPeriodOpen(orgId, date),
      getBaseCurrency: (orgId) => this.getBaseCurrency(orgId),
      nextSequenceNumber: (orgId, entryDate, executor) =>
        this.nextSequenceNumber(orgId, entryDate, executor),
    };
  }

  private get reverseDeps(): JournalReverseDeps {
    return {
      db: this.db,
      audit: this.audit,
      cache: this.cache,
      assertPeriodOpen: (orgId, date) => this.assertPeriodOpen(orgId, date),
      nextSequenceNumber: (orgId, entryDate, executor) =>
        this.nextSequenceNumber(orgId, entryDate, executor),
    };
  }

  async resolveSystemAccount(orgId: string, purpose: SystemAccountPurpose): Promise<number> {
    return this.accounts.resolveSystemAccount(orgId, purpose);
  }

  async assertPeriodOpen(orgId: string, date: string): Promise<void> {
    const periods = await this.db
      .select({ status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.orgId, orgId),
          lte(accountingPeriods.startDate, date),
          gte(accountingPeriods.endDate, date),
        ),
      )
      .limit(1);

    if (!periods[0]) {
      throw new BadRequestException(`No accounting period covers date ${date}`);
    }

    const { status } = periods[0];
    if (status === "CLOSED" || status === "LOCKED") {
      throw new BadRequestException(`Accounting period covering ${date} is ${status.toLowerCase()}`);
    }
  }

  private async getBaseCurrency(orgId: string): Promise<string> {
    const settings = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);
    return settings[0]?.baseCurrency ?? "INR";
  }

  private async nextSequenceNumber(orgId: string, entryDate: string, executor: DbOrTx): Promise<string> {
    const inserted = await executor
      .insert(accNumberSequences)
      .values({ orgId, entityType: "journal", prefix: "JE", nextNumber: 2, padding: 5 })
      .onConflictDoUpdate({
        target: [accNumberSequences.orgId, accNumberSequences.entityType],
        set: { nextNumber: sql`${accNumberSequences.nextNumber} + 1` },
      })
      .returning({
        next: accNumberSequences.nextNumber,
        padding: accNumberSequences.padding,
      });

    const row = inserted[0];
    if (!row) throw new Error("Sequence upsert returned no rows");
    const seq = row.next - 1;
    const pad = row.padding ?? 5;
    const period = yyyymm(entryDate);
    return `JE-${period}-${String(seq).padStart(pad, "0")}`;
  }

  /** @see postJournal — idempotent on (sourceType, sourceId, sourceEvent). */
  async postJournal(u: CurrentUserContext, input: PostJournalInput): Promise<PostJournalResult> {
    return postJournal(this.postDeps, u, input);
  }

  /** @see reverseJournal — writes a mirrored entry; never edits the original. */
  async reverseJournal(
    u: CurrentUserContext,
    entryId: number,
    reason?: string,
  ): Promise<ReverseJournalResult> {
    return reverseJournal(this.reverseDeps, u, entryId, reason);
  }

  async assertEntryNotPosted(orgId: string, entryId: number): Promise<void> {
    const rows = await this.db
      .select({ status: journalEntries.status })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, entryId),
          eq(journalEntries.orgId, orgId),
        ),
      )
      .limit(1);

    if (rows[0]?.status === "POSTED") {
      throw new BadRequestException("Cannot mutate a POSTED journal entry");
    }
  }

  async assertApprovalGranted(orgId: string, entryId: number): Promise<void> {
    const requests = await this.db
      .select({ status: finApprovalRequests.status })
      .from(finApprovalRequests)
      .where(
        and(
          eq(finApprovalRequests.orgId, orgId),
          eq(finApprovalRequests.recordType, "MANUAL_JOURNAL"),
          eq(finApprovalRequests.recordId, entryId),
        ),
      )
      .limit(1);

    if (requests.length === 0) return;

    if (requests[0]?.status !== "APPROVED") {
      throw new BadRequestException(
        "Journal entry requires approval before posting",
      );
    }
  }
}
