import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  surveyForms,
  surveyParticipants,
  surveyResponseSessions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { surveyResponseSubmittedPayloadSchema } from "./dto/survey-response-submitted-payload.schema";

const CONSUMER_NAME = "surveys:survey-response-submitted";

type TxHandle = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class SurveyResponseSubmittedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "survey.response.submitted";
  private readonly logger = new Logger(
    SurveyResponseSubmittedConsumerService.name,
  );

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      const txHandle = tx as TxHandle;
      const txInbox = new InboxConsumer(txHandle);

      const claimed = await txInbox.claim(CONSUMER_NAME, {
        eventId: event.eventId,
        organizationId: event.organizationId,
        aggregateVersion: event.aggregateVersion,
      });
      if (!claimed) {
        this.logger.debug(
          `survey.response.submitted ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
        );
        return;
      }

      const parseResult = surveyResponseSubmittedPayloadSchema.safeParse(
        event.payload,
      );
      if (!parseResult.success) {
        this.logger.warn(
          `survey.response.submitted ${event.eventId} has invalid payload: ${parseResult.error.message}`,
        );
        await txInbox.markProcessed(
          CONSUMER_NAME,
          event.eventId,
          "FAILED",
          parseResult.error.message,
        );
        return;
      }

      const { sessionId, surveyId, passed } = parseResult.data;
      const orgId = event.organizationId;

      const [survey] = await (tx as Db)
        .select({ ownerUserId: surveyForms.ownerUserId })
        .from(surveyForms)
        .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
        .limit(1);

      if (!survey) {
        this.logger.debug(
          `survey.response.submitted ${event.eventId}: survey ${surveyId} not found in org ${orgId} — skipping`,
        );
        await txInbox.markProcessed(
          CONSUMER_NAME,
          event.eventId,
          "SKIPPED",
          "survey not found",
        );
        return;
      }

      if (survey.ownerUserId) {
        await this.dispatch.emitDurable(txHandle, {
          orgId,
          eventKey: "survey.response.received",
          targetUserIds: [survey.ownerUserId],
          entityType: "survey",
          entityId: String(surveyId),
        });
      }

      if (passed !== null) {
        const [session] = await (tx as Db)
          .select({
            participantId: surveyResponseSessions.participantId,
            anonymous: surveyResponseSessions.anonymous,
          })
          .from(surveyResponseSessions)
          .where(
            and(
              eq(surveyResponseSessions.id, sessionId),
              eq(surveyResponseSessions.orgId, orgId),
            ),
          )
          .limit(1);

        if (session && !session.anonymous && session.participantId !== null) {
          const [participant] = await (tx as Db)
            .select({ userId: surveyParticipants.userId })
            .from(surveyParticipants)
            .where(
              and(
                eq(surveyParticipants.id, session.participantId),
                eq(surveyParticipants.orgId, orgId),
              ),
            )
            .limit(1);

          const respondentUserId = participant?.userId ?? null;
          if (respondentUserId) {
            const certKey = passed
              ? "survey.certification.passed"
              : "survey.certification.failed";
            await this.dispatch.emitDurable(txHandle, {
              orgId,
              eventKey: certKey,
              targetUserIds: [respondentUserId],
              entityType: "survey_response",
              entityId: String(sessionId),
            });
          }
        }
      }

      await txInbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "COMPLETED",
        null,
      );

      this.logger.log(
        `survey.response.submitted ${event.eventId}: notifications dispatched for session ${sessionId} org ${orgId}`,
      );
    });
  }
}
