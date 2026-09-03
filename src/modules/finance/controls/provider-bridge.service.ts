import { Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import { RateResolverService } from "./rate-resolver.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  accountingSettings,
  organizationMembers,
  organizations,
} from "../../../db/schema";
import {
  compareDecimals,
  decimalFromNumber,
  subtractDecimals,
} from "../../accounting/core/money.util";
import { systemActor } from "../../../common/auth/system-actor";

export interface RecordProviderPaymentInput {
  provider: string;
  providerEventId: string;
  clientId?: number;
  invoiceId?: number;
  grossAmount: string;
  feeAmount: string;
  currency: string;
  occurredAt: Date;
}

@Injectable()
export class ProviderBridgeService {
  constructor(
    private readonly finPosting: FinancePostingService,
    private readonly rates: RateResolverService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async recordProviderPayment(
    orgId: string,
    actorUserId: string,
    input: RecordProviderPaymentInput,
  ): Promise<void> {
    /*
     * `journal_entries.posted_by` is a validated FK to `users(id)`, so posting
     * as the literal "system" the webhook receiver passes raised 23503 and no
     * provider payment — in any currency — ever reached the ledger. Resolve a
     * real user before touching the posting service.
     */
    const postingUserId = await this.resolvePostingUserId(orgId, actorUserId);
    const user = systemActor(
      "finance.controls.provider-bridge",
      orgId,
      postingUserId,
    );

    /*
     * `postJournal` refuses an entry whose currency differs from the org's base
     * currency unless it is given a rate to value it at, so the bridge has to
     * resolve one. Money is carried as decimal strings at scale 4 throughout;
     * every amount below is in `input.currency`, major units.
     */
    const baseCurrency = await this.getBaseCurrency(orgId);
    const exchangeRate =
      input.currency === baseCurrency
        ? undefined
        : // units of baseCurrency per 1 unit of input.currency, scale-8 text
          await this.rates.getRateString(
            orgId,
            input.currency,
            baseCurrency,
            input.occurredAt,
          );

    // `decimalFromNumber` pins the incoming double to scale 4 exactly as the old
    // `Number(x).toFixed(4)` did; every operation after it is integer arithmetic,
    // so `net` can no longer drift the way an IEEE-754 subtraction could.
    const grossStr = decimalFromNumber(Number(input.grossAmount)); // input.currency, scale 4
    const feeStr = decimalFromNumber(Number(input.feeAmount)); // input.currency, scale 4
    const netStr = subtractDecimals(grossStr, feeStr); // input.currency, scale 4
    const hasFee = compareDecimals(feeStr, "0") > 0;
    const entryDate = input.occurredAt.toISOString().slice(0, 10);

    const lines: Array<{
      systemPurpose?: "AR" | "AP" | "BANK_CLEARING" | "PAYMENT_FEES" | "FX_GAIN_LOSS";
      debit?: string;
      credit?: string;
      clientId?: number;
    }> = [
      {
        systemPurpose: "BANK_CLEARING",
        debit: netStr,
      },
    ];

    if (hasFee) {
      lines.push({
        systemPurpose: "PAYMENT_FEES",
        debit: feeStr,
      });
    }

    lines.push({
      systemPurpose: "AR",
      credit: grossStr,
      clientId: input.clientId,
    });

    await this.finPosting.postJournal(user, {
      entryDate,
      description: `${input.provider} payment received (${input.currency}) event ${input.providerEventId}`,
      sourceType: "PROVIDER_PAYMENT",
      sourceId: input.providerEventId,
      sourceEvent: "payment_received",
      currency: input.currency,
      exchangeRate,
      lines,
    });
  }

  private async getBaseCurrency(orgId: string): Promise<string> {
    const settings = await this.db
      .select({ baseCurrency: accountingSettings.baseCurrency })
      .from(accountingSettings)
      .where(eq(accountingSettings.orgId, orgId))
      .limit(1);
    return settings[0]?.baseCurrency ?? "INR";
  }

  /**
   * A provider webhook carries no session, so the receiver hands the bridge a
   * placeholder actor. Honour it when it names a real member of this org, and
   * otherwise attribute the posting to the organisation's owner — the entry's
   * `source_type = PROVIDER_PAYMENT` and description carry the true provenance.
   */
  private async resolvePostingUserId(orgId: string, actorUserId: string): Promise<string> {
    // A membership row's user_id is an FK to users(id), so a hit here is already
    // a real user and needs no second lookup.
    const [member] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, actorUserId),
        ),
      )
      .limit(1);
    if (member) return member.userId;

    const [owner] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizations)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, organizations.id),
          eq(organizationMembers.id, organizations.ownerMembershipId),
        ),
      )
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (owner) return owner.userId;

    throw new InternalServerErrorException(
      `Cannot post provider payment for org ${orgId}: no owner membership to attribute it to`,
    );
  }
}
