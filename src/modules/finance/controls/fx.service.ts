import { Injectable } from "@nestjs/common";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  absDecimal,
  compareDecimals,
  isZero,
  subtractDecimals,
  toDecimal,
} from "../../accounting/core/money.util";

export interface PostRealizedGainLossInput {
  /** The settled document's kind — "invoice", "purchase_bill". Part of the ledger key. */
  sourceType: string;
  /** The settled document's id. Only unique WITHIN a sourceType. */
  sourceId: string;
  /**
   * The settlement that realized this gain or loss — the `payments` /
   * `vendor_payments` row id. One document can settle in several instalments at
   * several rates, and each realizes its own gain or loss, so the ledger key has
   * to name the instalment rather than the document.
   */
  settlementId: string;
  /** Base currency, scale 4: the document's amount at the rate it was booked at. */
  baseAmountBooked: string;
  /** Base currency, scale 4: the same amount at the rate it actually settled at. */
  baseAmountSettled: string;
  counterPurpose: "AR" | "AP" | "BANK_CLEARING";
}

@Injectable()
export class FxService {
  constructor(private readonly finPosting: FinancePostingService) {}

  async postRealizedGainLoss(
    user: CurrentUserContext,
    input: PostRealizedGainLossInput,
  ): Promise<void> {
    // Base currency, scale 4, exact: a double subtraction here can land either
    // side of the 0.0001 threshold below on values the ledger holds exactly.
    const diff = subtractDecimals(
      toDecimal(input.baseAmountSettled),
      toDecimal(input.baseAmountBooked),
    );

    if (isZero(diff)) return;

    const today = new Date().toISOString().slice(0, 10);

    /*
     * `uniq_je_idempotency` is (org_id, source_type, source_id, source_event).
     * A hardcoded source_type collapsed every kind of settlement into one
     * namespace, so invoice #42 and purchase bill #42 shared a key; a fixed
     * source_event collapsed every instalment of one document into one entry,
     * so only the first instalment's FX result was ever recorded. Both segments
     * are now carried by the caller.
     */
    const key = {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceEvent: `realized_gain_loss:${input.settlementId}`,
    };

    if (compareDecimals(diff, "0") > 0) {
      await this.finPosting.postJournal(user, {
        entryDate: today,
        description: `Realized FX gain on ${input.sourceType} ${input.sourceId}`,
        ...key,
        lines: [
          {
            systemPurpose: input.counterPurpose,
            debit: diff,
          },
          {
            systemPurpose: "FX_GAIN_LOSS",
            credit: diff,
          },
        ],
      });
    } else {
      const absDiff = absDecimal(diff);
      await this.finPosting.postJournal(user, {
        entryDate: today,
        description: `Realized FX loss on ${input.sourceType} ${input.sourceId}`,
        ...key,
        lines: [
          {
            systemPurpose: "FX_GAIN_LOSS",
            debit: absDiff,
          },
          {
            systemPurpose: input.counterPurpose,
            credit: absDiff,
          },
        ],
      });
    }
  }
}
