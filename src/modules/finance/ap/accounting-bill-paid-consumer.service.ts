import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
  outboxEffectIdempotencyKey,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { accountingBillPaidPayloadSchema } from "./dto/accounting-bill-paid-payload.schema";

const CONSUMER_NAME = "accounting:bill-paid";

@Injectable()
export class AccountingBillPaidConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "accounting.bill.paid";
  private readonly logger = new Logger(AccountingBillPaidConsumerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);

    const claimed = await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) {
      this.logger.debug(
        `accounting.bill.paid ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = accountingBillPaidPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `accounting.bill.paid ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
      return;
    }

    const {
      bill_number: billNumber,
      amount_cents: amountCents,
      actor_user_id: actorUserId,
      bill_id: billId,
    } = parseResult.data;
    const orgId = event.organizationId;

    await this.dispatch.emit({
      orgId,
      dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      eventKey: "accounting.payment.recorded",
      actorUserId,
      targetUserIds: [actorUserId],
      entityType: "purchase_bill",
      entityId: String(billId),
      variables: { billNumber, amount: amountCents / 100 },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `accounting.bill.paid ${event.eventId}: notified actor for bill ${billId}`,
    );
  }
}
