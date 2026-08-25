import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { finApprovalRequests } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { accountingBillApprovedPayloadSchema } from "./dto/accounting-bill-approved-payload.schema";

const CONSUMER_NAME = "accounting:bill-approved";

@Injectable()
export class AccountingBillApprovedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "accounting.bill.approved";
  private readonly logger = new Logger(AccountingBillApprovedConsumerService.name);

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
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) {
      this.logger.debug(
        `accounting.bill.approved ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = accountingBillApprovedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `accounting.bill.approved ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
      return;
    }

    const { bill_id: billId, bill_number: billNumber, total_cents: totalCents, actor_user_id: approverUserId } = parseResult.data;
    const orgId = event.organizationId;

    // The payload actor_user_id is the APPROVER, not the submitter.
    // The submitter is stored as finApprovalRequests.requestedBy, which mirrors the
    // existing accounting.bill.approval_requested dispatch that targets check.approverUserId.
    // If no approval request exists (bill approved directly without a submission workflow),
    // there is no recorded submitter and we skip — the audience is not determinable.
    const [approvalReq] = await this.db
      .select({ requestedBy: finApprovalRequests.requestedBy })
      .from(finApprovalRequests)
      .where(
        and(
          eq(finApprovalRequests.orgId, orgId),
          eq(finApprovalRequests.recordType, "PURCHASE_BILL"),
          eq(finApprovalRequests.recordId, billId),
        ),
      )
      .limit(1);

    if (!approvalReq) {
      this.logger.debug(
        `accounting.bill.approved ${event.eventId}: no approval request for bill ${billId} — skipping`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "no approval request");
      return;
    }

    await this.dispatch.emitDurable(this.db, {
      orgId,
      eventKey: "accounting.bill.approved",
      actorUserId: approverUserId,
      targetUserIds: [approvalReq.requestedBy],
      entityType: "purchase_bill",
      entityId: String(billId),
      variables: { billNumber, amount: totalCents / 100 },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `accounting.bill.approved ${event.eventId}: notified submitter for bill ${billId}`,
    );
  }
}
