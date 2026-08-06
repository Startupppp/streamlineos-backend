import { Injectable } from "@nestjs/common";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

export interface PostRealizedGainLossInput {
  sourceType: string;
  sourceId: string;
  baseAmountBooked: string;
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
    const booked = Number(input.baseAmountBooked);
    const settled = Number(input.baseAmountSettled);
    const diff = settled - booked;

    if (Math.abs(diff) < 0.0001) return;

    const today = new Date().toISOString().slice(0, 10);

    if (diff > 0) {
      await this.finPosting.postJournal(user, {
        entryDate: today,
        description: `Realized FX gain on ${input.sourceType} ${input.sourceId}`,
        sourceType: "fx_settlement",
        sourceId: input.sourceId,
        sourceEvent: "realized_gain_loss",
        lines: [
          {
            systemPurpose: input.counterPurpose,
            debit: diff.toFixed(4),
          },
          {
            systemPurpose: "FX_GAIN_LOSS",
            credit: diff.toFixed(4),
          },
        ],
      });
    } else {
      const absDiff = Math.abs(diff).toFixed(4);
      await this.finPosting.postJournal(user, {
        entryDate: today,
        description: `Realized FX loss on ${input.sourceType} ${input.sourceId}`,
        sourceType: "fx_settlement",
        sourceId: input.sourceId,
        sourceEvent: "realized_gain_loss",
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
