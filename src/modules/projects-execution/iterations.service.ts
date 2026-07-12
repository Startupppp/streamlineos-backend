import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { cycles, modules, sprints, tickets, timesheets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { addDays, differenceInCalendarDays, formatDateOnly } from "./date.helpers";
import type {
  CreateCycleInput,
  CreateEpicInput,
  CreateModuleInput,
  CreateSprintInput,
  CycleListQuery,
  UpdateCycleInput,
  UpdateEpicInput,
  UpdateModuleInput,
  UpdateSprintInput,
} from "./dto/iterations.schemas";
import { ProjectsWebhooksDispatchService } from "../projects/projects-webhooks-dispatch.service";

@Injectable()
export class SprintsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly webhooksDispatch: ProjectsWebhooksDispatchService | null,
  ) {}

  async listSprints(orgId: string, projectId: number) {
    const sprintList = await this.db
      .select({
        id: sprints.id,
        orgId: sprints.orgId,
        projectId: sprints.projectId,
        name: sprints.name,
        startDate: sprints.startDate,
        endDate: sprints.endDate,
        goal: sprints.goal,
        status: sprints.status,
      })
      .from(sprints)
      .where(and(eq(sprints.orgId, orgId), eq(sprints.projectId, projectId)))
      .orderBy(desc(sprints.startDate))
      .limit(100);

    if (sprintList.length === 0) return [];

    const sprintIds = sprintList.map((s) => s.id);
    const ticketRows = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        points: tickets.points,
        sprintId: tickets.sprintId,
      })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), inArray(tickets.sprintId, sprintIds)));

    const ticketsBySprintId = new Map<number, typeof ticketRows>();
    for (const ticket of ticketRows) {
      if (ticket.sprintId === null) continue;
      const existing = ticketsBySprintId.get(ticket.sprintId);
      if (existing) {
        existing.push(ticket);
      } else {
        ticketsBySprintId.set(ticket.sprintId, [ticket]);
      }
    }

    return sprintList.map((sprint) => ({
      ...sprint,
      tickets: ticketsBySprintId.get(sprint.id) ?? [],
    }));
  }

  async createSprint(orgId: string, projectId: number, input: CreateSprintInput) {
    const [sprint] = await this.db
      .insert(sprints)
      .values({
        orgId,
        projectId,
        name: input.name,
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        goal: input.goal,
        status: "PLANNED",
      })
      .returning();

    return sprint;
  }

  async getSprint(orgId: string, sprintId: number) {
    const sprint = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId)),
      with: { tickets: { with: { assignee: true } } },
    });
    if (!sprint) throw new NotFoundException("Sprint not found");
    return sprint;
  }

  async updateSprint(orgId: string, sprintId: number, input: UpdateSprintInput, actorId?: string) {
    const before = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId)),
      columns: { id: true, name: true, status: true, projectId: true },
    });

    await this.db
      .update(sprints)
      .set({
        ...(input.name && { name: input.name }),
        ...(input.startDate && { startDate: new Date(input.startDate) }),
        ...(input.endDate && { endDate: new Date(input.endDate) }),
        ...(input.goal !== undefined && { goal: input.goal }),
        ...(input.status && { status: input.status }),
      })
      .where(and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId)));

    if (before && input.status && input.status !== before.status && this.webhooksDispatch) {
      const eventName =
        input.status === "ACTIVE"
          ? "sprint.started"
          : input.status === "COMPLETED"
            ? "sprint.completed"
            : null;
      if (eventName) {
        this.webhooksDispatch.dispatch(orgId, before.projectId, eventName, {
          id: sprintId,
          projectId: before.projectId,
          name: input.name ?? before.name,
          status: input.status,
          actor: actorId ?? "system",
          timestamp: new Date().toISOString(),
        });
      }
    }

    return { success: true };
  }

  async deleteSprint(orgId: string, projectId: number, sprintId: number) {
    const sprint = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId), eq(sprints.projectId, projectId)),
      columns: { id: true },
    });
    if (!sprint) throw new NotFoundException("Sprint not found");
    await this.db.delete(sprints).where(and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId)));
    return { success: true };
  }

  async burndown(orgId: string, sprintId: number) {
    const sprint = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId)),
      with: { tickets: true },
    });
    if (!sprint) throw new NotFoundException("Sprint not found");

    const totalPoints = sprint.tickets.reduce((sum, t) => sum + (t.points || 0), 0);

    const startDate = new Date(sprint.startDate);
    const endDate = new Date(sprint.endDate);
    const days = differenceInCalendarDays(endDate, startDate) + 1;

    const idealBurndown = Array.from({ length: days }).map((_, i) => {
      const date = addDays(startDate, i);
      const remainingDays = days - i;
      const idealPoints = Math.max(0, (totalPoints / days) * remainingDays);
      return { date, points: idealPoints };
    });

    const allTimeEntries = await this.db
      .select({
        ticketId: timesheets.ticketId,
        date: timesheets.date,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.orgId, orgId),
          gte(timesheets.date, formatDateOnly(startDate)),
          lte(timesheets.date, formatDateOnly(endDate)),
          sql`${timesheets.ticketId} IN (SELECT id FROM tickets WHERE sprint_id = ${sprintId})`,
        ),
      );

    const completedTickets = sprint.tickets.filter((t) => t.status === "DONE");
    const completedPointsByDate = new Map<string, number>();

    completedTickets.forEach((ticket) => {
      const ticketEntries = allTimeEntries.filter((e) => e.ticketId === ticket.id);
      if (ticketEntries.length > 0) {
        const lastEntry = ticketEntries.reduce((latest, entry) =>
          new Date(entry.date) > new Date(latest.date) ? entry : latest,
        );
        const dateKey = formatDateOnly(new Date(lastEntry.date));
        const current = completedPointsByDate.get(dateKey) || 0;
        completedPointsByDate.set(dateKey, current + (ticket.points || 0));
      }
    });

    let cumulativePoints = 0;
    const actualBurndown = idealBurndown.map((ideal) => {
      const dateKey = formatDateOnly(ideal.date);
      const dayPoints = completedPointsByDate.get(dateKey) || 0;
      cumulativePoints += dayPoints;
      return { date: ideal.date, points: totalPoints - cumulativePoints };
    });

    return { sprint, totalPoints, idealBurndown, actualBurndown };
  }
}

@Injectable()
export class CyclesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listCycles(orgId: string, projectId: number, query: CycleListQuery) {
    const conditions = [eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)];
    if (query.status) conditions.push(eq(cycles.status, query.status));

    const cycleList = await this.db
      .select()
      .from(cycles)
      .where(and(...conditions))
      .orderBy(cycles.startDate)
      .limit(100);

    if (cycleList.length === 0) return [];

    const cycleIds = cycleList.map((c) => c.id);
    const statsRows = await this.db
      .select({
        cycleId: tickets.cycleId,
        total: count(),
        completed: count(sql`CASE WHEN ${tickets.status} = 'DONE' THEN 1 END`),
      })
      .from(tickets)
      .where(sql`${tickets.cycleId} IN (${sql.join(cycleIds.map((cid) => sql`${cid}`), sql`, `)})`)
      .groupBy(tickets.cycleId);

    const statsMap = new Map(statsRows.map((s) => [s.cycleId, s]));

    return cycleList.map((cycle) => {
      const stats = statsMap.get(cycle.id);
      const total = Number(stats?.total ?? 0);
      const completed = Number(stats?.completed ?? 0);
      return {
        ...cycle,
        totalItems: total,
        completedItems: completed,
        progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      };
    });
  }

  async createCycle(orgId: string, userId: string, projectId: number, input: CreateCycleInput) {
    const overlapping = await this.db
      .select({ id: cycles.id })
      .from(cycles)
      .where(
        and(
          eq(cycles.projectId, projectId),
          eq(cycles.orgId, orgId),
          or(
            and(lte(cycles.startDate, input.startDate), gte(cycles.endDate, input.startDate)),
            and(lte(cycles.startDate, input.endDate), gte(cycles.endDate, input.endDate)),
            and(gte(cycles.startDate, input.startDate), lte(cycles.endDate, input.endDate)),
          ),
        ),
      )
      .limit(1);

    if (overlapping.length > 0) {
      throw new ConflictException("Cycle dates overlap with an existing cycle.");
    }

    const [cycle] = await this.db
      .insert(cycles)
      .values({
        projectId,
        orgId,
        name: input.name,
        description: input.description,
        startDate: input.startDate,
        endDate: input.endDate,
        createdBy: userId,
      })
      .returning();

    return cycle;
  }

  async updateCycle(orgId: string, projectId: number, cycleId: number, input: UpdateCycleInput) {
    if (input.status === "active") {
      const [existing] = await this.db
        .select({ id: cycles.id })
        .from(cycles)
        .where(
          and(eq(cycles.status, "active"), eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)),
        )
        .limit(1);

      if (existing && existing.id !== cycleId) {
        throw new ConflictException("Only one active cycle is allowed at a time per project.");
      }
    }

    const [updated] = await this.db
      .update(cycles)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(cycles.id, cycleId), eq(cycles.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Cycle not found");
    return updated;
  }

  async deleteCycle(orgId: string, cycleId: number) {
    await this.db.update(tickets).set({ cycleId: null }).where(eq(tickets.cycleId, cycleId));
    await this.db.delete(cycles).where(and(eq(cycles.id, cycleId), eq(cycles.orgId, orgId)));
    return { success: true };
  }
}

@Injectable()
export class ModulesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listModules(orgId: string, projectId: number) {
    const moduleList = await this.db
      .select()
      .from(modules)
      .where(and(eq(modules.projectId, projectId), eq(modules.orgId, orgId)))
      .orderBy(asc(modules.name))
      .limit(100);

    if (moduleList.length === 0) return [];

    const moduleIds = moduleList.map((m) => m.id);
    const statsRows = await this.db
      .select({
        moduleId: tickets.moduleId,
        total: count(),
        completed: count(sql`CASE WHEN ${tickets.status} = 'DONE' THEN 1 END`),
      })
      .from(tickets)
      .where(sql`${tickets.moduleId} IN (${sql.join(moduleIds.map((mid) => sql`${mid}`), sql`, `)})`)
      .groupBy(tickets.moduleId);

    const statsMap = new Map(statsRows.map((s) => [s.moduleId, s]));

    return moduleList.map((mod) => {
      const stats = statsMap.get(mod.id);
      const total = Number(stats?.total ?? 0);
      const completed = Number(stats?.completed ?? 0);
      return {
        ...mod,
        totalItems: total,
        completedItems: completed,
        progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      };
    });
  }

  async createModule(orgId: string, userId: string, projectId: number, input: CreateModuleInput) {
    const [mod] = await this.db
      .insert(modules)
      .values({
        projectId,
        orgId,
        name: input.name,
        description: input.description,
        status: input.status,
        leadId: input.leadId,
        startDate: input.startDate,
        endDate: input.endDate,
        createdBy: userId,
      })
      .returning();

    return mod;
  }

  async updateModule(orgId: string, moduleId: number, input: UpdateModuleInput) {
    const [updated] = await this.db
      .update(modules)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(modules.id, moduleId), eq(modules.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Module not found");
    return updated;
  }

  async deleteModule(orgId: string, moduleId: number) {
    await this.db.update(tickets).set({ moduleId: null }).where(eq(tickets.moduleId, moduleId));
    await this.db.delete(modules).where(and(eq(modules.id, moduleId), eq(modules.orgId, orgId)));
    return { success: true };
  }
}

@Injectable()
export class EpicsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listEpics(orgId: string, projectId: number) {
    return this.db.query.tickets.findMany({
      where: and(
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "EPIC"),
      ),
      with: { assignee: true },
      orderBy: [desc(tickets.createdAt)],
      limit: 100,
    });
  }

  async createEpic(orgId: string, userId: string, projectId: number, input: CreateEpicInput) {
    const [epic] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const maxResult = await tx
        .select({ maxTicketNumber: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));

      const nextNumber = (maxResult[0]?.maxTicketNumber || 0) + 1;

      return tx
        .insert(tickets)
        .values({
          orgId,
          projectId,
          ticketNumber: nextNumber,
          title: input.title,
          description: input.description,
          type: "EPIC",
          priority: input.priority ?? "MEDIUM",
          assigneeId: input.assigneeId,
          reporterId: userId,
          points: input.points,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          status: "TODO",
        })
        .returning();
    });

    return epic;
  }

  async updateEpic(orgId: string, projectId: number, epicId: number, input: UpdateEpicInput) {
    const [updated] = await this.db
      .update(tickets)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(tickets.id, epicId),
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.type, "EPIC"),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Epic not found");
    return updated;
  }

  async deleteEpic(orgId: string, projectId: number, epicId: number) {
    const epic = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, epicId),
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "EPIC"),
      ),
      columns: { id: true },
    });
    if (!epic) throw new NotFoundException("Epic not found");
    await this.db.update(tickets).set({ epicId: null }).where(eq(tickets.epicId, epicId));
    await this.db.delete(tickets).where(and(eq(tickets.id, epicId), eq(tickets.orgId, orgId)));
    return { success: true };
  }
}
