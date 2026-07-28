import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { eq, and, desc, sql, count, or, inArray, isNull } from "drizzle-orm";
import type { DataScope } from "../access/access.types";
import { Redis } from "@upstash/redis";
import {
  clientAccounts,
  clientAccountActivities,
  incentives,
  incentiveConfig,
  notifications,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { ClientsEmailService } from "./clients-email.service";
import type {
  CreateActivityInput,
  ListAccountsInput,
  UpdateClientStatusInput,
  UpdateRenewalInput,
} from "./dto/clients.schemas";

const CUSTOMER_SUPPORT = "CUSTOMER_SUPPORT";

@Injectable()
export class ClientAccountsService {
  private readonly logger = new Logger(ClientAccountsService.name);
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
    private readonly audit: AuditService,
    private readonly clientsEmail: ClientsEmailService,
  ) {}

  async getClientAccounts(
    orgId: string,
    scope: DataScope,
    userId: string,
    filters: ListAccountsInput,
  ) {
    void this.tryBackfill(orgId, userId);

    const f = [eq(clientAccounts.orgId, orgId)];
    if (scope === "own") f.push(eq(clientAccounts.salesRepId, userId));
    if (scope === "none") f.push(sql`false`);
    if (filters.status) f.push(eq(clientAccounts.status, filters.status));
    if (filters.search) {
      const s = `%${filters.search}%`;
      f.push(
        or(
          sql`${clientAccounts.clientName} ILIKE ${s}`,
          sql`${clientAccounts.clientEmail} ILIKE ${s}`,
          sql`${clientAccounts.clientPhone} ILIKE ${s}`,
        )!,
      );
    }

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 25;
    const offset = (page - 1) * limit;

    const [items, [countResult]] = await Promise.all([
      this.db.query.clientAccounts.findMany({
        where: and(...f),
        orderBy: [desc(clientAccounts.createdAt)],
        limit,
        offset,
        with: {
          salesRep: { columns: { id: true, name: true, image: true } },
          assignedCrm: { columns: { id: true, name: true, image: true } },
        },
      }),
      this.db.select({ count: count() }).from(clientAccounts).where(and(...f)),
    ]);

    return {
      accounts: items,
      totalCount: countResult?.count ?? 0,
      page,
      totalPages: Math.ceil((countResult?.count ?? 0) / limit),
    };
  }

  getClientAccount(orgId: string, id: number) {
    return this.loadClientAccount(orgId, id);
  }

  private async loadClientAccount(orgId: string, id: number) {
    const account = await this.db.query.clientAccounts.findFirst({
      where: and(eq(clientAccounts.id, id), eq(clientAccounts.orgId, orgId)),
      with: {
        salesRep: { columns: { id: true, name: true, image: true, email: true } },
        assignedCrm: { columns: { id: true, name: true, image: true, email: true } },
        lead: { columns: { id: true, name: true, source: true, priority: true } },
      },
    });
    if (!account) return null;

    const activities = await this.db.query.clientAccountActivities.findMany({
      where: eq(clientAccountActivities.clientAccountId, id),
      orderBy: [desc(clientAccountActivities.createdAt)],
      with: { user: { columns: { id: true, name: true, image: true } } },
    });

    return { ...account, activities };
  }

  async getClientActivities(orgId: string, clientAccountId: number) {
    const account = await this.db.query.clientAccounts.findFirst({
      where: and(eq(clientAccounts.id, clientAccountId), eq(clientAccounts.orgId, orgId)),
      columns: { id: true },
    });
    if (!account) return [];

    return this.db.query.clientAccountActivities.findMany({
      where: eq(clientAccountActivities.clientAccountId, clientAccountId),
      orderBy: [desc(clientAccountActivities.createdAt)],
      with: { user: { columns: { id: true, name: true, image: true } } },
      limit: 100,
    });
  }

  async addActivity(orgId: string, clientAccountId: number, userId: string, input: CreateActivityInput) {
    const account = await this.db.query.clientAccounts.findFirst({
      where: and(eq(clientAccounts.id, clientAccountId), eq(clientAccounts.orgId, orgId)),
      columns: { id: true },
    });
    if (!account) return null;

    const [activity] = await this.db
      .insert(clientAccountActivities)
      .values({
        clientAccountId,
        userId,
        activityType: input.activityType,
        title: input.title,
        description: input.description,
        metadata: input.metadata,
      })
      .returning();

    return activity;
  }

  listRenewals(orgId: string) {
    return this.db.query.clientAccounts.findMany({
      where: eq(clientAccounts.orgId, orgId),
      with: { salesRep: { columns: { id: true, name: true } } },
      orderBy: (t, { asc }) => [asc(t.clientName)],
      limit: 100,
    });
  }

  async updateRenewal(orgId: string, accountId: number, input: UpdateRenewalInput) {
    const existing = await this.db.query.clientAccounts.findFirst({
      where: and(eq(clientAccounts.id, accountId), eq(clientAccounts.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) return null;

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.renewalStage !== undefined) updateData.renewalStage = input.renewalStage;
    if (input.renewalDate !== undefined) updateData.renewalDate = input.renewalDate;
    if (input.renewalNotes !== undefined) updateData.renewalNotes = input.renewalNotes;

    const [updated] = await this.db
      .update(clientAccounts)
      .set(updateData)
      .where(and(eq(clientAccounts.id, accountId), eq(clientAccounts.orgId, orgId)))
      .returning();

    return updated;
  }

  async updateStatus(orgId: string, userId: string, accountId: number, input: UpdateClientStatusInput) {
    const account = await this.db.query.clientAccounts.findFirst({
      where: and(eq(clientAccounts.id, accountId), eq(clientAccounts.orgId, orgId)),
    });
    if (!account) return null;

    const investmentAmount = input.investmentAmount;
    const isInvested = input.status === "INVESTED";
    if (isInvested && !investmentAmount) {
      throw new BadRequestException("Investment amount is required for INVESTED status");
    }

    const updateData: Partial<typeof clientAccounts.$inferInsert> = {
      status: input.status,
      updatedAt: new Date(),
    };
    if (isInvested && investmentAmount) {
      updateData.investmentAmount = investmentAmount;
      updateData.planName = input.planName ?? null;
      updateData.investmentDate = input.investmentDate ? new Date(input.investmentDate) : new Date();
      updateData.transactionRef = input.transactionRef ?? null;
      updateData.investedAt = new Date();
    }

    const recordInvestment = isInvested && !!investmentAmount;
    const formattedAmount = investmentAmount
      ? Number.parseFloat(investmentAmount).toLocaleString("en-IN")
      : "";

    const hrMemberRows = recordInvestment
      ? await this.db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "HR")))
      : [];

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(clientAccounts)
        .set(updateData)
        .where(and(eq(clientAccounts.id, accountId), eq(clientAccounts.orgId, orgId)))
        .returning();

      await tx.insert(clientAccountActivities).values({
        clientAccountId: accountId,
        userId,
        activityType: "status_change",
        title: `Status changed to ${input.status}`,
        description: recordInvestment ? `Investment: ${investmentAmount}, Plan: ${input.planName || "N/A"}` : null,
      });

      if (recordInvestment && investmentAmount) {
        const [config] = await tx
          .select({ incentiveRate: incentiveConfig.incentiveRate })
          .from(incentiveConfig)
          .where(and(eq(incentiveConfig.orgId, orgId), eq(incentiveConfig.isActive, true)))
          .orderBy(desc(incentiveConfig.effectiveFrom))
          .limit(1);

        if (config) {
          const amount = Number.parseFloat(investmentAmount);
          const rate = Number.parseFloat(config.incentiveRate);
          const calculated = (amount * rate) / 100;
          await tx.insert(incentives).values({
            orgId,
            clientAccountId: accountId,
            salesRepId: account.salesRepId,
            investmentAmount,
            incentiveRate: config.incentiveRate,
            calculatedAmount: String(calculated),
            branchId: account.branchId,
          });
        }

        await tx.insert(notifications).values({
          orgId,
          userId: account.salesRepId,
          type: "SUCCESS",
          title: "Client Invested!",
          message: `${account.clientName} has invested ₹${formattedAmount}. Your incentive is being processed.`,
          link: `/crm/clients/${account.id}`,
        });

        if (hrMemberRows.length > 0) {
          const investmentMsg = `${account.clientName} has invested ₹${formattedAmount}. Sales rep: ${account.salesRepId ? "assigned" : "N/A"}.`;
          await tx.insert(notifications).values(
            hrMemberRows.map((hr) => ({
              orgId,
              userId: hr.userId,
              type: "SUCCESS" as const,
              title: "Client Invested!",
              message: investmentMsg,
              link: `/crm/clients/${account.id}`,
            })),
          );
        }
      }

      return row;
    });

    this.audit.log({
      action: "client.status_changed",
      userId,
      orgId,
      targetId: String(accountId),
      targetType: "client",
      metadata: { status: input.status, investmentAmount: input.investmentAmount },
    });

    if (recordInvestment) {
      void this.clientsEmail
        .sendInvestmentEmails(
          account.id,
          account.salesRepId,
          account.clientName,
          formattedAmount,
          hrMemberRows.map((m) => m.userId),
        )
        .catch(() => undefined);
    }

    return updated;
  }

  async getCrmAssignmentStats(orgId: string) {
    const csMembers = await this.db
      .select({ userId: organizationMembers.userId, name: users.name, image: users.image })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, CUSTOMER_SUPPORT)));

    if (csMembers.length === 0) {
      return { members: [], unassignedCount: 0 };
    }

    const memberIds = csMembers.map((m) => m.userId);

    const [countRows, [unassignedResult]] = await Promise.all([
      this.db
        .select({
          userId: clientAccounts.assignedCrmId,
          totalCount: count(),
          activeCount: sql<number>`count(*) FILTER (WHERE ${clientAccounts.status} != 'INVESTED')`,
        })
        .from(clientAccounts)
        .where(and(eq(clientAccounts.orgId, orgId), inArray(clientAccounts.assignedCrmId, memberIds)))
        .groupBy(clientAccounts.assignedCrmId),
      this.db
        .select({ count: count() })
        .from(clientAccounts)
        .where(and(eq(clientAccounts.orgId, orgId), isNull(clientAccounts.assignedCrmId))),
    ]);

    const countMap = new Map(countRows.map((r) => [r.userId, r]));

    return {
      members: csMembers.map((m) => ({
        userId: m.userId,
        name: m.name,
        image: m.image,
        activeCount: Number(countMap.get(m.userId)?.activeCount ?? 0),
        totalCount: countMap.get(m.userId)?.totalCount ?? 0,
      })),
      unassignedCount: unassignedResult?.count ?? 0,
    };
  }

  async runCrmAssignments(orgId: string) {
    await this.backfillCrmAssignments(orgId);
    return this.getCrmAssignmentStats(orgId);
  }

  private async tryBackfill(orgId: string, userId: string): Promise<void> {
    const lockKey = `clients:backfill:${orgId}`;
    if (this.redis) {
      try {
        const acquired = await this.redis.set(lockKey, "1", { ex: 60, nx: true });
        if (!acquired) return;
      } catch (err) {
        this.logger.warn(`Redis lock acquire failed for client backfill ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await this.backfillConvertedLeadsToClientAccounts(orgId, userId);
      await this.backfillCrmAssignments(orgId);
    } catch (err) {
      this.logger.warn(`Client account backfill failed for org ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async backfillConvertedLeadsToClientAccounts(orgId: string, fallbackSalesRepId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO client_accounts (
        org_id, lead_id, sales_rep_id,
        client_name, client_email, client_phone, client_whatsapp,
        estimated_investment, status, converted_at, created_at, updated_at
      )
      SELECT
        l.org_id,
        l.id,
        COALESCE(l.assigned_to_id, ${fallbackSalesRepId}),
        l.name,
        l.email,
        l.phone,
        l.whatsapp_number,
        COALESCE(l.potential_value, l.investment_interest)::numeric(15,2),
        'ACCOUNT_OPENING'::text,
        COALESCE(l.converted_at, NOW()),
        NOW(),
        NOW()
      FROM leads l
      WHERE l.org_id = ${orgId}
        AND l.status = 'CONVERTED'
        AND l.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM client_accounts ca
          WHERE ca.org_id = l.org_id AND ca.lead_id = l.id
        )
    `);
  }

  private async backfillCrmAssignments(orgId: string): Promise<void> {
    const csMembers = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, CUSTOMER_SUPPORT)));

    if (csMembers.length === 0) return;

    const memberIds = csMembers.map((m) => m.userId);

    const [countRows, unassigned] = await Promise.all([
      this.db
        .select({ userId: clientAccounts.assignedCrmId, activeCount: count() })
        .from(clientAccounts)
        .where(
          and(
            eq(clientAccounts.orgId, orgId),
            inArray(clientAccounts.assignedCrmId, memberIds),
            sql`${clientAccounts.status} != 'INVESTED'`,
          ),
        )
        .groupBy(clientAccounts.assignedCrmId),
      this.db
        .select({ id: clientAccounts.id })
        .from(clientAccounts)
        .where(and(eq(clientAccounts.orgId, orgId), isNull(clientAccounts.assignedCrmId)))
        .orderBy(desc(clientAccounts.createdAt)),
    ]);

    if (unassigned.length === 0) return;

    const counts: Record<string, number> = Object.fromEntries(memberIds.map((id) => [id, 0]));
    for (const row of countRows) {
      if (row.userId) counts[row.userId] = row.activeCount;
    }

    const assignments: Record<string, number[]> = {};
    for (const account of unassigned) {
      let minCount = Infinity;
      let assignee: string | null = null;
      for (const id of memberIds) {
        if ((counts[id] ?? 0) < minCount) {
          minCount = counts[id] ?? 0;
          assignee = id;
        }
      }
      if (assignee) {
        (assignments[assignee] ??= []).push(account.id);
        counts[assignee] = (counts[assignee] ?? 0) + 1;
      }
    }

    const now = new Date();
    await Promise.all(
      Object.entries(assignments).map(([assigneeId, ids]) =>
        this.db
          .update(clientAccounts)
          .set({ assignedCrmId: assigneeId, updatedAt: now })
          .where(and(eq(clientAccounts.orgId, orgId), inArray(clientAccounts.id, ids))),
      ),
    );
  }
}
