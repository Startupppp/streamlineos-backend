import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { calendarEvents, eventAttendees, invoices, signEnvelopes, supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant";
import { NotificationDispatchService } from "../notification-dispatch.service";

export interface TimeSweepResult {
  slaBreached: number;
  invoicesDueSoon: number;
  envelopesExpiring: number;
  eventsStartingSoon: number;
}

/**
 * REG-003, the time-derived events whose owning modules have no sweep of their own.
 *
 * Each of these was declared in the catalog and could never fire, because nothing a user
 * does triggers them — an SLA is breached by the clock, not by a click. They are grouped
 * here rather than scattered as four near-identical services: every one reads a single
 * table, resolves its recipient from a column on that row, and emits. There is no module
 * business logic involved, so there is nothing for the owning modules to own.
 *
 * Every predicate matches a BOUNDARY (the day something crosses), never a range. A range
 * would re-notify the entire historical backlog on every run.
 */
@Injectable()
export class NotificationTimeSweepsService {
  private readonly logger = new Logger(NotificationTimeSweepsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async sweep(): Promise<TimeSweepResult> {
    const result: TimeSweepResult = {
      slaBreached: 0,
      invoicesDueSoon: 0,
      envelopesExpiring: 0,
      eventsStartingSoon: 0,
    };

    await forEachOrg(this.db, "notification-time-sweeps", async (tx, orgId) => {
      await this.sweepSlaBreaches(tx, orgId, result);
      await this.sweepInvoicesDueSoon(tx, orgId, result);
      await this.sweepEnvelopesExpiring(tx, orgId, result);
      await this.sweepEventsStartingSoon(tx, orgId, result);
    });

    const total =
      result.slaBreached +
      result.invoicesDueSoon +
      result.envelopesExpiring +
      result.eventsStartingSoon;
    if (total > 0) {
      this.logger.log(
        `TIME_SWEEPS: ${result.slaBreached} SLA, ${result.invoicesDueSoon} invoice, ` +
          `${result.envelopesExpiring} envelope, ${result.eventsStartingSoon} calendar notification(s)`,
      );
    }
    return result;
  }

  /**
   * A breach is past, not pending, so this fires on the hour the deadline passes rather
   * than on a day boundary — an SLA notification a day late has no value. The one-hour
   * window means the sweep must run at least hourly; running it more often re-emits
   * inside the window and the dispatcher's dedupe absorbs it.
   */
  private async sweepSlaBreaches(tx: Db, orgId: string, result: TimeSweepResult): Promise<void> {
    const rows = await tx
      .select({
        id: supportTickets.id,
        title: supportTickets.title,
        assigneeId: supportTickets.assigneeId,
      })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, orgId),
          isNotNull(supportTickets.assigneeId),
          isNotNull(supportTickets.firstResponseDueAt),
          notInArray(supportTickets.status, ["RESOLVED", "CLOSED"]),
          sql`${supportTickets.firstResponseDueAt} <= now()`,
          sql`${supportTickets.firstResponseDueAt} > now() - interval '1 hour'`,
        ),
      )
      .limit(500);

    for (const ticket of rows) {
      if (!ticket.assigneeId) continue;
      await this.dispatch.emit({
        eventKey: "support.ticket.sla_breached",
        orgId,
        targetUserIds: [ticket.assigneeId],
        entityType: "support_ticket",
        entityId: String(ticket.id),
        title: `SLA breached: ${ticket.title}`,
        message: "The first-response deadline for this ticket has passed.",
        link: `/support/tickets/${ticket.id}`,
      });
      result.slaBreached += 1;
    }
  }

  private async sweepInvoicesDueSoon(tx: Db, orgId: string, result: TimeSweepResult): Promise<void> {
    const rows = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        dueDate: invoices.dueDate,
        createdBy: invoices.createdBy,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, orgId),
          // Only invoices actually awaiting payment: a draft has not been issued and
          // a paid or voided one needs no chasing. "CANCELLED" does not exist on this enum.
          inArray(invoices.status, ["ISSUED", "SENT", "PARTIALLY_PAID"]),
          sql`${invoices.dueDate} = current_date + 3`,
        ),
      )
      .limit(500);

    for (const invoice of rows) {
      await this.dispatch.emit({
        eventKey: "billing.invoice.due_soon",
        orgId,
        targetUserIds: [invoice.createdBy],
        entityType: "invoice",
        entityId: String(invoice.id),
        title: `Invoice ${invoice.invoiceNumber} is due soon`,
        message: `Payment is due on ${invoice.dueDate}.`,
        link: `/billing/invoices/${invoice.id}`,
      });
      result.invoicesDueSoon += 1;
    }
  }

  /**
   * The sender is notified, not the signer: signers are external parties who have no
   * user account here, and the person who can act on an expiring envelope — extend it,
   * chase the signer, re-send it — is the one who sent it.
   */
  private async sweepEnvelopesExpiring(
    tx: Db,
    orgId: string,
    result: TimeSweepResult,
  ): Promise<void> {
    const rows = await tx
      .select({
        id: signEnvelopes.id,
        title: signEnvelopes.title,
        senderUserId: signEnvelopes.senderUserId,
      })
      .from(signEnvelopes)
      .where(
        and(
          eq(signEnvelopes.orgId, orgId),
          isNotNull(signEnvelopes.senderUserId),
          isNotNull(signEnvelopes.expiresAt),
          inArray(signEnvelopes.status, ["sent", "partially_completed"]),
          sql`${signEnvelopes.expiresAt}::date = current_date + 2`,
        ),
      )
      .limit(500);

    for (const envelope of rows) {
      if (!envelope.senderUserId) continue;
      await this.dispatch.emit({
        eventKey: "sign.document.expiring",
        orgId,
        targetUserIds: [envelope.senderUserId],
        entityType: "sign_envelope",
        entityId: String(envelope.id),
        title: `Signature request expiring: ${envelope.title}`,
        message: "This envelope expires in two days and is not yet complete.",
        link: `/sign/envelopes/${envelope.id}`,
      });
      result.envelopesExpiring += 1;
    }
  }

  /**
   * `attendeeIds` is a JSONB array of user ids, so the membership test has to happen in
   * SQL rather than by loading every event and filtering in JS.
   */
  private async sweepEventsStartingSoon(
    tx: Db,
    orgId: string,
    result: TimeSweepResult,
  ): Promise<void> {
    const rows = await tx
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        createdBy: calendarEvents.createdBy,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          sql`${calendarEvents.startDate} > now()`,
          lte(calendarEvents.startDate, sql`now() + interval '30 minutes'`),
        ),
      )
      .limit(200);

    const attendeeRows = rows.length === 0 ? [] : await tx
      .select({ eventId: eventAttendees.eventId, userId: eventAttendees.userId })
      .from(eventAttendees)
      .where(and(eq(eventAttendees.orgId, orgId), inArray(eventAttendees.eventId, rows.map((event) => event.id))));
    const attendeesByEvent = new Map<number, string[]>();
    for (const attendee of attendeeRows) {
      if (!attendee.userId) continue;
      const users = attendeesByEvent.get(attendee.eventId) ?? [];
      users.push(attendee.userId);
      attendeesByEvent.set(attendee.eventId, users);
    }

    for (const event of rows) {
      const attendees = attendeesByEvent.get(event.id) ?? [];
      const targets = [...new Set([...attendees, event.createdBy])].filter(Boolean);
      if (targets.length === 0) continue;
      await this.dispatch.emit({
        eventKey: "calendar.event.starting_soon",
        orgId,
        targetUserIds: targets,
        entityType: "calendar_event",
        entityId: String(event.id),
        title: `Starting soon: ${event.title}`,
        message: "This event starts within the next 30 minutes.",
        link: `/calendar?event=${event.id}`,
      });
      result.eventsStartingSoon += 1;
    }
  }
}
