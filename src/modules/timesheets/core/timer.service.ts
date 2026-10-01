import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timerSessions, timesheetSettings, projects, tickets } from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { EntriesService } from "./entries.service";
import { utcDateOnly } from "./lib/period.helpers";
import { buildTimerShape, elapsedSeconds } from "./lib/timer-shape";
import {
  discardTimer,
  pauseTimer,
  resumeTimer,
  stopTimer,
  type TimerTransitionDeps,
} from "./lib/timer-transitions";
import type { StartTimerInput, ConvertTimerInput } from "./dto/timer.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const CONVERTIBLE_TIMER_STATUSES = ["STOPPED", "PAUSED"] as const;

@Injectable()
export class TimerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entries: EntriesService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  private async fetchTimerWithRelations(orgId: string, timerId: number) {
    const timerProj = alias(projects, "tp");

    const [row] = await this.db
      .select({
        id: timerSessions.id,
        orgId: timerSessions.orgId,
        userMembershipId: timerSessions.userMembershipId,
        projectId: timerSessions.projectId,
        ticketId: timerSessions.ticketId,
        description: timerSessions.description,
        billable: timerSessions.billable,
        startedAt: timerSessions.startedAt,
        lastResumedAt: timerSessions.lastResumedAt,
        accumulatedSeconds: timerSessions.accumulatedSeconds,
        status: timerSessions.status,
        source: timerSessions.source,
        createdAt: timerSessions.createdAt,
        updatedAt: timerSessions.updatedAt,
        projectName: timerProj.name,
        ticketTitle: tickets.title,
      })
      .from(timerSessions)
      .leftJoin(timerProj, eq(timerSessions.projectId, timerProj.id))
      .leftJoin(tickets, and(eq(timerSessions.ticketId, tickets.id), isNull(tickets.deletedAt)))
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, orgId)));

    return row ?? null;
  }

  async getActive(u: CurrentUserContext) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null) return null;

    const timerProj = alias(projects, "tp");

    const rows = await this.db
      .select({
        id: timerSessions.id,
        orgId: timerSessions.orgId,
        userMembershipId: timerSessions.userMembershipId,
        projectId: timerSessions.projectId,
        ticketId: timerSessions.ticketId,
        description: timerSessions.description,
        billable: timerSessions.billable,
        startedAt: timerSessions.startedAt,
        lastResumedAt: timerSessions.lastResumedAt,
        accumulatedSeconds: timerSessions.accumulatedSeconds,
        status: timerSessions.status,
        source: timerSessions.source,
        createdAt: timerSessions.createdAt,
        updatedAt: timerSessions.updatedAt,
        projectName: timerProj.name,
        ticketTitle: tickets.title,
      })
      .from(timerSessions)
      .leftJoin(timerProj, eq(timerSessions.projectId, timerProj.id))
      .leftJoin(tickets, and(eq(timerSessions.ticketId, tickets.id), isNull(tickets.deletedAt)))
      .where(
        and(
          eq(timerSessions.orgId, u.orgId),
          eq(timerSessions.userMembershipId, membershipId),
          inArray(timerSessions.status, ["RUNNING", "PAUSED"]),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return buildTimerShape(row);
  }

  async startTimer(u: CurrentUserContext, input: StartTimerInput) {
    const membershipId = actingMembershipId(u.principal);

    const active = await this.getActive(u);

    if (active) {
      const [settings] = await this.db
        .select({ allowOverlapping: timesheetSettings.allowOverlappingEntries })
        .from(timesheetSettings)
        .where(eq(timesheetSettings.orgId, u.orgId))
        .limit(1);

      const allowOverlapping = settings?.allowOverlapping ?? true;
      if (!allowOverlapping) {
        throw new ConflictException("An active timer is already running. Stop it before starting a new one.");
      }
    }

    const now = new Date();
    const [session] = await this.db
      .insert(timerSessions)
      .values({
        orgId: u.orgId,
        userMembershipId: membershipId,
        projectId: input.projectId ?? null,
        ticketId: input.ticketId ?? null,
        description: input.description ?? null,
        billable: input.billable ?? false,
        startedAt: now,
        lastResumedAt: now,
        accumulatedSeconds: 0,
        status: "RUNNING",
        source: "WEB",
      })
      .returning();

    if (!session) throw new InternalServerErrorException("Failed to create timer session");
    const row = await this.fetchTimerWithRelations(u.orgId, session.id);
    if (!row) throw new InternalServerErrorException("Timer not found after creation");
    return buildTimerShape(row);
  }

  async pauseTimer(u: CurrentUserContext, timerId: number) {
    return pauseTimer(this.transitionDeps, u, timerId);
  }

  async resumeTimer(u: CurrentUserContext, timerId: number) {
    return resumeTimer(this.transitionDeps, u, timerId);
  }

  async stopTimer(u: CurrentUserContext, timerId: number) {
    return stopTimer(this.transitionDeps, u, timerId);
  }

  async discardTimer(u: CurrentUserContext, timerId: number) {
    return discardTimer(this.transitionDeps, u, timerId);
  }

  private get transitionDeps(): TimerTransitionDeps {
    return {
      db: this.db,
      reloadTimer: (orgId, timerId) => this.fetchTimerWithRelations(orgId, timerId),
    };
  }

  async convertTimer(u: CurrentUserContext, timerId: number, input: ConvertTimerInput) {
    const membershipId = actingMembershipId(u.principal);
    const session = await this.db.query.timerSessions.findFirst({
      where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
    });
    if (!session) throw new NotFoundException("Timer not found");
    if (session.userMembershipId !== membershipId) throw new ForbiddenException("Not your timer");

    const [claimed] = await this.db
      .update(timerSessions)
      .set({ status: "CONVERTED", updatedAt: new Date() })
      .where(
        and(
          eq(timerSessions.id, timerId),
          eq(timerSessions.orgId, u.orgId),
          inArray(timerSessions.status, CONVERTIBLE_TIMER_STATUSES),
        ),
      )
      .returning();
    if (!claimed) throw new ConflictException("Stop or pause the timer before converting");

    const accSeconds = elapsedSeconds(claimed);
    const hours = input.hours ?? Math.max(Math.round((accSeconds / 3600) * 100) / 100, 0.01);
    const date = input.date ?? utcDateOnly(new Date());

    const entry = await this.entries
      .createEntry(u, {
        date,
        hours,
        projectId: claimed.projectId ?? undefined,
        ticketId: claimed.ticketId ?? undefined,
        description: input.description ?? claimed.description ?? undefined,
        isBillable: input.isBillable ?? claimed.billable,
        billingType: (input.isBillable ?? claimed.billable) ? "BILLABLE" : "NON_BILLABLE",
        source: "TIMER",
      })
      .catch(async (error: unknown) => {
        await this.db
          .update(timerSessions)
          .set({ status: "PAUSED", updatedAt: new Date() })
          .where(
            and(
              eq(timerSessions.id, timerId),
              eq(timerSessions.orgId, u.orgId),
              eq(timerSessions.status, "CONVERTED"),
            ),
          );
        throw error;
      });

    await this.audit.recordWithDb({
      orgId: u.orgId,
      actorMembershipId: membershipId,
      entityType: "timer",
      entityId: timerId.toString(),
      action: "timer.converted",
      after: { entryId: entry.id, hours, date },
    });

    return entry;
  }
}
