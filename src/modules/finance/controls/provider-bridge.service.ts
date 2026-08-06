import { Injectable } from "@nestjs/common";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
  constructor(private readonly finPosting: FinancePostingService) {}

  async recordProviderPayment(
    orgId: string,
    actorUserId: string,
    input: RecordProviderPaymentInput,
  ): Promise<void> {
    const user: CurrentUserContext = {
      userId: actorUserId,
      orgId,
      role: "SYSTEM",
      permissions: [],
      isOrgOwner: false,
      tokenScopes: null,
      sessionId: "provider-webhook",
    };
    const gross = Number(input.grossAmount);
    const fee = Number(input.feeAmount);
    const net = gross - fee;
    const entryDate = input.occurredAt.toISOString().slice(0, 10);

    const grossStr = gross.toFixed(4);
    const feeStr = fee > 0 ? fee.toFixed(4) : null;
    const netStr = net.toFixed(4);

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

    if (feeStr && fee > 0) {
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
      lines,
    });
  }
}
