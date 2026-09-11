import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import { SIGN_BULK_SEND_QUEUED, SignBulkSendService } from "./sign-bulk-send.service";

/**
 * Runs a queued bulk send.
 *
 * The registration is not bookkeeping: `OutboxPublisherService` throws on an
 * event type it has no consumer for and sends that throw down the retry and
 * dead-letter path. Emitting `sign.bulk_send.queued` without this class would
 * not mean "jobs are queued and nothing runs them" — it would mean every bulk
 * send dead-letters, which looks identical to the synchronous version failing
 * except that nobody gets an error.
 */
@Injectable()
export class SignBulkSendConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = SIGN_BULK_SEND_QUEUED;
  private readonly logger = new Logger(SignBulkSendConsumer.name);

  constructor(
    private readonly bulk: SignBulkSendService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const payload = event.payload as { job_id?: unknown };
    const jobId = Number(payload?.job_id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw new Error(`${SIGN_BULK_SEND_QUEUED} payload has no usable job_id`);
    }

    /**
     * Throws propagate deliberately. A job with rows still pending ends by
     * throwing, which is how the outbox brings the event back for another
     * pass — and how a job that cannot finish eventually dead-letters, in
     * public, instead of sitting at "running" forever.
     */
    const result = await this.bulk.processQueuedJob(event.organizationId, jobId);
    this.logger.debug(
      `bulk send job ${jobId}: processed ${result.processed}, ` +
        `${result.succeeded} sent, ${result.failed} failed`,
    );
  }
}
