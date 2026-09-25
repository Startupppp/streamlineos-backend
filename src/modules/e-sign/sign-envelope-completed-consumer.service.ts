import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { organizationMembers, quotes, signEnvelopes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
  outboxEffectIdempotencyKey,
} from "../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { SignFinalizationService } from "./sign-finalization.service";
import { QuotesLifecycleService } from "../quotes/quotes-lifecycle.service";
import { ProjectsProvisionService } from "../build/core/projects-provision.service";

const payloadSchema = z.object({
  envelopeId: z.number().int(),
  orgId: z.string(),
});

const CONSUMER_NAME = "sign:envelope-completed";

@Injectable()
export class SignEnvelopeCompletedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "sign.envelope.completed";
  private readonly logger = new Logger(SignEnvelopeCompletedConsumerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: OutboxConsumerRegistry,
    private readonly dispatch: NotificationDispatchService,
    private readonly finalization: SignFinalizationService,
    private readonly quotesLifecycle: QuotesLifecycleService,
    private readonly projectsProvision: ProjectsProvisionService,
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
        `sign.envelope.completed ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = payloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `sign.envelope.completed ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
      return;
    }

    const { envelopeId } = parseResult.data;
    const orgId = event.organizationId;

    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
      columns: {
        senderMembershipId: true,
        orgId: true,
        title: true,
        sourceModule: true,
        sourceEntityType: true,
        sourceEntityId: true,
        finalPdfFileKey: true,
      },
    });

    if (!envelope) {
      this.logger.debug(
        `sign.envelope.completed ${event.eventId}: envelope ${envelopeId} not found — skipping`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "envelope not found");
      return;
    }

    /*
     * The signed PDF, the certificate and the completed-copy emails. This ran
     * inside the last signer's request transaction, which held a pooled
     * connection for as long as the storage provider and the PDF stamping
     * took and rolled the signature back when either failed. Here it is
     * durable — the event committed with the envelope's status — retried by
     * the relay on failure, and idempotent: a certificate that already exists
     * is returned, and a claim another attempt still holds is a 409 that the
     * relay turns into a later retry. It comes before the sender's
     * notification so that "completed" arrives once the document can be
     * downloaded.
     */
    await this.finalization.finalize(orgId, envelopeId);

    if (envelope.senderMembershipId == null) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "sender membership not found");
      return;
    }

    const senderMember = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, envelope.senderMembershipId)),
      with: { user: { columns: { id: true } } },
    });

    if (!senderMember?.user?.id) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "sender user not found");
      return;
    }

    if (
      envelope.sourceModule === "crm" &&
      envelope.sourceEntityType === "quote" &&
      envelope.sourceEntityId !== null
    ) {
      const quoteId = Number(envelope.sourceEntityId);
      if (Number.isSafeInteger(quoteId) && quoteId > 0) {
        const quote = await this.db.query.quotes.findFirst({
          where: and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)),
          columns: { dealId: true, subject: true },
        });
        if (quote) {
          await this.quotesLifecycle.markSigned(
            orgId,
            senderMember.user.id,
            quoteId,
            envelope.finalPdfFileKey ?? undefined,
          );
          if (quote.dealId !== null) {
            await this.projectsProvision.createFromDeal(orgId, senderMember.user.id, {
              dealId: quote.dealId,
              name: quote.subject,
            });
          }
        }
      }
    }

    await this.dispatch.emit({
      orgId,
      dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      eventKey: "sign.document.completed",
      targetUserIds: [senderMember.user.id],
      entityType: "sign_envelope",
      entityId: String(envelopeId),
      variables: { title: envelope.title },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `sign.envelope.completed ${event.eventId}: notified sender ${senderMember.user.id} for envelope ${envelopeId}`,
    );
  }
}
