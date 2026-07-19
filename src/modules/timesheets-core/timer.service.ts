import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timerSessions, timesheetSettings, projects, tickets } from "../../db/schema";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { EntriesService } from "./entries.service";
import { formatDateOnly } from "./lib/period.helpers";
import type { StartTimerInput, ConvertTimerInput } from "./dto/timer.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function elapsedSeconds(session: {
  accumulatedSeconds: number;
  status: string;
  lastResumedAt: Date | null;
}): number {
  if (session.status !== "RUNNING" || !session.lastResumedAt) {
    return session.accumulatedSeconds;
  }
  const sinceResume = Math.floor((Date.now() - session.lastResumedAt.getTime()) / 1000);
  return session.accumulatedSeconds + sinceResume;
}

function buildTimerShape(
  session: typeof timerSessions.$inferSelect & {
    projectName?: string | null;
    ticketTitle?: string | null;
  },
) {
  return {
    id: session.id,
    userId: session.userId,
    projectId: session.projectId,
    ticketId: session.ticketId,
    description: session.description,
    billable: session.billable,
    startedAt: session.startedAt,
    lastResumedAt: session.lastResumedAt,
    accumulatedSeconds: session.accumulatedSeconds,
    status: session.status,
    elapsedSeconds: elapsedSeconds(session),
    project:
      session.projectId && session.projectName
        ? { id: session.projectId, name: session.projectName }
        : null,
    ticket:
      session.ticketId && session.ticketTitle
        ? { id: session.ticketId, title: session.ticketTitle }
        : null,
  };
}

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
        userId: timerSessions.userId,
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
      .leftJoin(tickets, eq(timerSessions.ticketId, tickets.id))
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, orgId)));

    return row ?? null;
  }

  async getActive(u: CurrentUserContext) {
    const timerProj = alias(projects, "tp");

    const rows = await this.db
      .select({
        id: timerSessions.id,
        orgId: timerSessions.orgId,
        userId: timerSessions.userId,
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
      .leftJoin(tickets, eq(timerSessions.ticketId, tickets.id))
      .where(
        and(
          eq(timerSessions.orgId, u.orgId),
          eq(timerSessions.userId, u.userId),
          inArray(timerSessions.status, ["RUNNING", "PAUSED"]),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return buildTimerShape(row);
  }

  async startTimer(u: CurrentUserContext, input: StartTimerInput) {
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
        userId: u.userId,
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

    const row = await this.fetchTimerWithRelations(u.orgId, session!.id);
    return buildTimerShape(row!);
  }

  async pauseTimer(u: CurrentUserContext, timerId: number) {
    const session = await this.db.query.timerSessions.findFirst({
      where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
    });
    if (!session) throw new NotFoundException("Timer not found");
    if (session.userId !== u.userId) throw new ForbiddenException("Not your timer");
    if (session.status !== "RUNNING") throw new ConflictException("Timer is not running");

    const sinceResume = session.lastResumedAt
      ? Math.floor((Date.now() - session.lastResumedAt.getTime()) / 1000)
      : 0;
    const newAccumulated = session.accumulatedSeconds + sinceResume;

    await this.db
      .update(timerSessions)
      .set({ status: "PAUSED", accumulatedSeconds: newAccumulated, updatedAt: new Date() })
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));

    const row = await this.fetchTimerWithRelations(u.orgId, timerId);
    return buildTimerShape(row!);
  }

  async resumeTimer(u: CurrentUserContext, timerId: number) {
    const session = await this.db.query.timerSessions.findFirst({
      where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
    });
    if (!session) throw new NotFoundException("Timer not found");
    if (session.userId !== u.userId) throw new ForbiddenException("Not your timer");
    if (session.status !== "PAUSED") throw new ConflictException("Timer is not paused");

    await this.db
      .update(timerSessions)
      .set({ status: "RUNNING", lastResumedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));

    const row = await this.fetchTimerWithRelations(u.orgId, timerId);
    return buildTimerShape(row!);
  }

  async stopTimer(u: CurrentUserContext, timerId: number) {
    const session = await this.db.query.timerSessions.findFirst({
      where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
    });
    if (!session) throw new NotFoundException("Timer not found");
    if (session.userId !== u.userId) throw new ForbiddenException("Not your timer");
    if (!["RUNNING", "PAUSED"].includes(session.status)) {
      throw new ConflictException("Timer is not active");
    }

    let newAccumulated = session.accumulatedSeconds;
    if (session.status === "RUNNING" && session.lastResumedAt) {
      newAccumulated += Math.floor((Date.now() - session.lastResumedAt.getTime()) / 1000);
    }

    await this.db
      .update(timerSessions)
      .set({ status: "STOPPED", accumulatedSeconds: newAccumulated, updatedAt: new Date() })
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));

    const row = await this.fetchTimerWithRelations(u.orgId, timerId);
    return buildTimerShape(row!);
  }

  async discardTimer(u: CurrentUserContext, timerId: number) {
    const session = await this.db.query.timerSessions.findFirst({
      where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
    });
    if (!session) throw new NotFoundException("Timer not found");
    if (session.userId !== u.userId) throw new ForbiddenException("Not your timer");

    await this.db
      .update(timerSessions)
      .set({ status: "DISCARDED", updatedAt: new Date() })
      .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));

    return { success: true };
  }

  async convertTimer(u: CurrentUserContext, timerId: number, input: ConvertTimerInput) {
    const session = await this.db.query.timerSessions.findFirst({
      where: and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)),
    });
    if (!session) throw new NotFoundException("Timer not found");
    if (session.userId !== u.userId) throw new ForbiddenException("Not your timer");
    if (!["STOPPED", "PAUSED"].includes(session.status)) {
      throw new ConflictException("Stop or pause the timer before converting");
    }

    let accSeconds = session.accumulatedSeconds;
    if (session.status === "PAUSED" && session.lastResumedAt) {
      accSeconds += Math.floor((Date.now() - session.lastResumedAt.getTime()) / 1000);
    }

    const hours = input.hours ?? Math.max(Math.round((accSeconds / 3600) * 100) / 100, 0.01);
    const date = input.date ?? formatDateOnly(new Date());

    const entry = await this.entries.createEntry(u, {
      date,
      hours,
      projectId: session.projectId ?? undefined,
      ticketId: session.ticketId ?? undefined,
      description: input.description ?? session.description ?? undefined,
      isBillable: input.isBillable ?? session.billable,
      billingType: (input.isBillable ?? session.billable) ? "BILLABLE" : "NON_BILLABLE",
      source: "TIMER",
    });

    await this.db.transaction(async (tx) => {
      await tx
        .update(timerSessions)
        .set({ status: "CONVERTED", updatedAt: new Date() })
        .where(and(eq(timerSessions.id, timerId), eq(timerSessions.orgId, u.orgId)));
    });

    await this.audit.recordWithDb({
      orgId: u.orgId,
      actorUserId: u.userId,
      entityType: "timer",
      entityId: timerId.toString(),
      action: "timer.converted",
      after: { entryId: entry.id, hours, date },
    });

    return entry;
  }
}
