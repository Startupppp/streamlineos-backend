import { Inject, Injectable } from "@nestjs/common";
import {
  eq,
  and,
  desc,
  asc,
  sql,
  count,
  gte,
  lte,
  or,
  inArray,
} from "drizzle-orm";
import {
  leads,
  departmentMembers,
  leadActivities,
  notifications,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import { pushBranchAssigneeFilter, type BranchContext } from "./branch-filter";
import {
  evaluateAssignmentRules,
  recalculateLeadScore,
  applySlaPolicy,
} from "./lead-triggers";
import type {
  ListInput,
  CreateInput,
  UpdateInput,
  IngestInput,
} from "./dto/lead.schemas";

type ListFilters = ListInput & { role?: string; userId?: string; branch?: BranchContext };
type BoardOpts = { role?: string; userId?: string; branch?: BranchContext; limitPerStatus?: number };
type StatsFilters = { dateFrom?: string; dateTo?: string; role?: string; userId?: string; branch?: BranchContext };

export type AssigneeNotMember = { error: "assignee_not_member" };

export function isAssigneeNotMember(value: unknown): value is AssigneeNotMember {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error === "assignee_not_member"
  );
}

@Injectable()
export class LeadsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
  ) {}

  private async sendLeadAssignedNotification(
    actorId: string,
    lead: { assignedToId: string; name: string; source: string; priority: string },
  ): Promise<void> {
    const ids = Array.from(new Set([lead.assignedToId, actorId]));
    const people = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));

    const rep = people.find((p) => p.id === lead.assignedToId);
    if (!rep?.email) return;

    const actor = people.find((p) => p.id === actorId);
    await this.email.sendLeadAssignedEmail(
      rep.email,
      rep.name ?? "Team Member",
      lead.name,
      lead.source,
      lead.priority,
      actor?.name ?? "Manager",
    );
  }

  async listLeads(orgId: string, filters?: ListFilters) {
    const where = [eq(leads.orgId, orgId)];

    if (filters?.branch) {
      await pushBranchAssigneeFilter(this.db, where, leads.assignedToId, filters.branch);
    }

    if (filters?.role === "SALES" && filters.userId) {
      where.push(eq(leads.assignedToId, filters.userId));
    }
    if (filters?.status) where.push(eq(leads.status, filters.status));
    if (filters?.priority) where.push(eq(leads.priority, filters.priority));
    if (filters?.source) where.push(eq(leads.source, filters.source));
    if (filters?.assignedToId) where.push(eq(leads.assignedToId, filters.assignedToId));
    if (filters?.dateFrom) where.push(gte(leads.createdAt, new Date(filters.dateFrom)));
    if (filters?.dateTo) where.push(lte(leads.createdAt, new Date(filters.dateTo)));
    if (filters?.search) {
      const s = `%${filters.search.toLowerCase()}%`;
      where.push(
        or(
          sql`LOWER(${leads.name}) LIKE ${s}`,
          sql`LOWER(${leads.email}) LIKE ${s}`,
          sql`${leads.phone} LIKE ${s}`,
          sql`LOWER(${leads.company}) LIKE ${s}`,
        )!,
      );
    }

    const colMap = {
      name: leads.name,
      email: leads.email,
      company: leads.company,
      status: leads.status,
      priority: leads.priority,
      source: leads.source,
      score: leads.score,
      potentialValue: leads.potentialValue,
      createdAt: leads.createdAt,
    } as const;

    const sortBy = filters?.sortBy ?? "createdAt";
    const sortOrder = filters?.sortOrder ?? "desc";
    const orderCol = colMap[sortBy as keyof typeof colMap] ?? leads.createdAt;
    const orderFn = sortOrder === "asc" ? asc(orderCol) : desc(orderCol);

    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 50;
    const offset = (page - 1) * limit;
    const whereClause = and(...where);

    const [allLeads, totalResult] = await Promise.all([
      this.db.query.leads.findMany({
        where: whereClause,
        with: {
          assignedTo: { columns: { id: true, name: true, image: true } },
          campaign: { columns: { id: true, name: true } },
        },
        orderBy: [orderFn],
        limit,
        offset,
      }),
      this.db.select({ count: count() }).from(leads).where(whereClause),
    ]);

    const totalCount = totalResult[0]?.count ?? 0;
    return {
      leads: allLeads,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
    };
  }

  async getBoard(orgId: string, opts?: BoardOpts) {
    const filters = [eq(leads.orgId, orgId)];
    const role = opts?.role;
    const userId = opts?.userId;

    if (opts?.branch) {
      await pushBranchAssigneeFilter(this.db, filters, leads.assignedToId, opts.branch);
    }

    if (role === "SALES" && userId) {
      filters.push(eq(leads.assignedToId, userId));
    } else if (userId && role && !["CEO", "HR"].includes(role)) {
      const teamLeadDepts = await this.db.query.departmentMembers.findMany({
        where: and(
          eq(departmentMembers.userId, userId),
          eq(departmentMembers.role, "lead"),
        ),
      });
      if (teamLeadDepts.length > 0) {
        const deptIds = teamLeadDepts.map((d) => d.departmentId);
        const teamMembers = await this.db.query.departmentMembers.findMany({
          where: inArray(departmentMembers.departmentId, deptIds),
        });
        const teamUserIds = [...new Set(teamMembers.map((m) => m.userId))];
        filters.push(inArray(leads.assignedToId, teamUserIds));
      } else {
        filters.push(eq(leads.assignedToId, userId));
      }
    }

    const statusCount = 6;
    const cap = (opts?.limitPerStatus ?? 50) * statusCount;
    const allLeads = await this.db.query.leads.findMany({
      where: and(...filters),
      with: { assignedTo: { columns: { id: true, name: true, image: true } } },
      orderBy: [desc(leads.createdAt)],
      limit: cap,
    });

    const board: Record<string, typeof allLeads> = {
      NEW: [],
      CONTACTED: [],
      INTERESTED: [],
      QUALIFIED: [],
      CONVERTED: [],
      LOST: [],
    };

    for (const lead of allLeads) {
      if (board[lead.status]) {
        board[lead.status].push(lead);
      }
    }

    return board as {
      NEW: typeof allLeads;
      CONTACTED: typeof allLeads;
      INTERESTED: typeof allLeads;
      QUALIFIED: typeof allLeads;
      CONVERTED: typeof allLeads;
      LOST: typeof allLeads;
    };
  }

  async getStats(orgId: string, filters?: StatsFilters) {
    const statsFilters = [eq(leads.orgId, orgId)];
    if (filters?.branch) {
      await pushBranchAssigneeFilter(this.db, statsFilters, leads.assignedToId, filters.branch);
    }
    if (filters?.role === "SALES" && filters.userId) {
      statsFilters.push(eq(leads.assignedToId, filters.userId));
    }

    if (filters?.dateFrom) {
      statsFilters.push(gte(leads.createdAt, new Date(filters.dateFrom)));
    }
    if (filters?.dateTo) {
      const to = new Date(filters.dateTo);
      to.setHours(23, 59, 59, 999);
      statsFilters.push(lte(leads.createdAt, to));
    }

    const allLeads = await this.db.query.leads.findMany({ where: and(...statsFilters) });

    const total = allLeads.length;
    const byStatus = {
      NEW: allLeads.filter((l) => l.status === "NEW").length,
      CONTACTED: allLeads.filter((l) => l.status === "CONTACTED").length,
      INTERESTED: allLeads.filter((l) => l.status === "INTERESTED").length,
      QUALIFIED: allLeads.filter((l) => l.status === "QUALIFIED").length,
      CONVERTED: allLeads.filter((l) => l.status === "CONVERTED").length,
      LOST: allLeads.filter((l) => l.status === "LOST").length,
    };

    const conversionRate = total > 0 ? (byStatus.CONVERTED / total) * 100 : 0;
    const totalPotentialValue = allLeads.reduce(
      (s, l) => s + Number(l.potentialValue ?? 0),
      0,
    );
    const unassigned = allLeads.filter((l) => !l.assignedToId).length;

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = allLeads.filter((l) => new Date(l.createdAt!) >= thisMonthStart).length;

    return {
      total,
      byStatus,
      conversionRate: Math.round(conversionRate * 10) / 10,
      totalPotentialValue,
      unassigned,
      thisMonth,
    };
  }

  async getLead(orgId: string, id: number) {
    return this.db.query.leads.findFirst({
      where: and(eq(leads.id, id), eq(leads.orgId, orgId)),
      with: {
        assignedTo: { columns: { id: true, name: true, image: true, email: true } },
        assignedBy: { columns: { id: true, name: true } },
        campaign: { columns: { id: true, name: true } },
        activities: {
          with: { user: { columns: { id: true, name: true, image: true } } },
          orderBy: [desc(leadActivities.date)],
        },
      },
    });
  }

  async create(orgId: string, userId: string, input: CreateInput) {
    if (input.assignedToId) {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.userId, input.assignedToId), eq(organizationMembers.orgId, orgId)),
        columns: { userId: true },
      });
      if (!member) {
        const notMember: AssigneeNotMember = { error: "assignee_not_member" };
        return notMember;
      }
    }

    const [newLead] = await this.db.insert(leads).values({
      orgId,
      name: input.name,
      email: input.email || null,
      phone: input.phone,
      whatsappNumber: input.whatsappNumber,
      source: input.source,
      campaignId: input.campaignId,
      priority: input.priority,
      investmentInterest: input.investmentInterest,
      potentialValue: input.potentialValue,
      notes: input.notes,
      company: input.company,
      designation: input.designation,
      city: input.city,
      referredBy: input.referredBy,
      tags: input.tags,
      assignedToId: input.assignedToId || null,
      assignedById: input.assignedToId ? userId : null,
      assignedAt: input.assignedToId ? new Date() : null,
    }).returning();

    if (input.assignedToId) {
      await this.db.insert(notifications).values({
        orgId,
        userId: input.assignedToId,
        type: "INFO",
        title: "New Lead Assigned",
        message: `You have been assigned a new lead: ${input.name}`,
        link: `/crm/leads`,
      });
    }

    if (!input.assignedToId) {
      try {
        await evaluateAssignmentRules(this.db, orgId, newLead.id);
      } catch (error) {
        logger.error("Auto-trigger: assignment rules failed", { leadId: newLead.id, error });
      }
    }

    try {
      await recalculateLeadScore(this.db, orgId, newLead.id);
    } catch (error) {
      logger.error("Auto-trigger: lead scoring failed", { leadId: newLead.id, error });
    }

    try {
      await applySlaPolicy(this.db, orgId, newLead.id);
    } catch (error) {
      logger.error("Auto-trigger: SLA policy failed", { leadId: newLead.id, error });
    }

    await this.cache.invalidatePattern(`leads:*:${orgId}:*`);

    this.audit.log({
      action: "lead.created",
      userId,
      orgId,
      targetId: String(newLead.id),
      targetType: "lead",
      metadata: { name: newLead.name, source: newLead.source, assignedToId: newLead.assignedToId },
    });

    if (newLead.assignedToId) {
      void this.sendLeadAssignedNotification(userId, {
        assignedToId: newLead.assignedToId,
        name: newLead.name,
        source: newLead.source,
        priority: newLead.priority,
      }).catch(() => undefined);
    }

    void this.automation
      .runAutomationsForEvent(orgId, "lead.created", {
        id: newLead.id,
        name: newLead.name,
        email: newLead.email,
        source: newLead.source,
        assignedToId: newLead.assignedToId,
      })
      .catch(() => undefined);

    return newLead;
  }

  async update(orgId: string, userId: string, id: number, input: UpdateInput) {
    const { ...data } = input;

    const [updated] = await this.db.update(leads)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(leads.id, id), eq(leads.orgId, orgId)))
      .returning();

    if (!updated) return null;

    this.audit.log({
      action: "lead.updated",
      userId,
      orgId,
      targetId: String(id),
      targetType: "lead",
      metadata: { changedFields: Object.keys(input) },
    });

    try {
      await recalculateLeadScore(this.db, orgId, updated.id);
    } catch (error) {
      logger.error("Auto-trigger: lead scoring on update failed", { leadId: updated.id, error });
    }

    return updated;
  }

  async remove(orgId: string, userId: string, id: number) {
    await this.db.delete(leads)
      .where(and(eq(leads.id, id), eq(leads.orgId, orgId)));
    this.audit.log({
      action: "lead.deleted",
      userId,
      orgId,
      targetId: String(id),
      targetType: "lead",
    });
    return { success: true };
  }

  async ingestCreate(orgId: string, input: IngestInput) {
    const [lead] = await this.db
      .insert(leads)
      .values({
        orgId,
        name: input.name ?? input.email ?? input.phone ?? "Unknown",
        email: input.email ?? null,
        phone: input.phone ?? null,
        company: input.company ?? null,
        source: "other" as const,
        notes: input.notes ?? null,
        status: "NEW" as const,
      })
      .returning({ id: leads.id });

    void Promise.allSettled([
      evaluateAssignmentRules(this.db, orgId, lead.id).catch((e: unknown) =>
        logger.error("Ingest: assignment rules failed", { leadId: lead.id, error: e }),
      ),
      recalculateLeadScore(this.db, orgId, lead.id).catch((e: unknown) =>
        logger.error("Ingest: lead scoring failed", { leadId: lead.id, error: e }),
      ),
      applySlaPolicy(this.db, orgId, lead.id).catch((e: unknown) =>
        logger.error("Ingest: SLA policy failed", { leadId: lead.id, error: e }),
      ),
    ]);

    return { id: lead.id };
  }
}
