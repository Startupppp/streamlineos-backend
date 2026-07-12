import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { FinancePostingService } from "../accounting/finance-posting.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

/**
 * INTEGRATION POINT — CALLER LOCATION:
 *
 * To wire this into the payments module, call `ProviderBridgeService.recordProviderPayment`
 * from the following location:
 *
 *   File:   backend/src/modules/payments/payment-webhook-health.service.ts
 *   Method: PaymentWebhookHealthService.processIncomingWebhook
 *
 * After the successful `inserted` check (line ~248) and before the `return { status: 200 }`,
 * extract the payment fields from `envelope.payload` and call:
 *
 *   await this.providerBridge.recordProviderPayment(params.orgId, systemUserId, {
 *     provider:          params.providerKey,
 *     providerEventId:   providerEventId,
 *     clientId:          resolvedClientId,   // optional
 *     invoiceId:         resolvedInvoiceId,  // optional
 *     grossAmount:       String(entity.amount / 100),
 *     feeAmount:         String(entity.fee / 100),
 *     currency:          entity.currency.toUpperCase(),
 *     occurredAt:        new Date(entity.created_at * 1000),
 *   });
 *
 * ProviderBridgeService must be injected into PaymentWebhookHealthService and
 * FinanceControlsModule must be imported by PaymentsModule.
 */

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
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly finPosting: FinancePostingService,
  ) {}

  async recordProviderPayment(
    orgId: string,
    actorUserId: string,
    input: RecordProviderPaymentInput,
  ): Promise<void> {
    const user: CurrentUserContext = { orgId, userId: actorUserId };
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
