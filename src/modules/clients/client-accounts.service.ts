import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, sql, count, or, inArray, isNull } from "drizzle-orm";
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
import { EmailService } from "../email/email.service";
import type {
  CreateActivityInput,
  ListAccountsInput,
  UpdateClientStatusInput,
  UpdateRenewalInput,
} from "./dto/clients.schemas";

const SALES = "SALES";
const CUSTOMER_SUPPORT = "CUSTOMER_SUPPORT";

function resolveAppUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function notificationEmailHtml(title: string, message: string, link?: string): string {
  const baseUrl = resolveAppUrl();
  const button = link
    ? `<div style="text-align:center;margin:24px 0;"><a href="${baseUrl}${link}" style="background:#0f2b7f;color:#bd882c;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;">View Details</a></div>`
    : "";
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><div style="background:linear-gradient(135deg,#0f2b7f,#1e40af);padding:24px;text-align:center;border-radius:10px 10px 0 0;"><h1 style="color:#bd882c;margin:0;font-size:22px;">StreamlineOS</h1></div><div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;"><h2 style="color:#1e40af;margin-top:0;">${title}</h2><p>${message}</p>${button}</div></body></html>`;
}

@Injectable()
export class ClientAccountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async getClientAccounts(
    orgId: string,
    role: string,
    userId: string,
    filters: ListAccountsInput,
  ) {
    void this.tryBackfill(orgId, userId);

    const f = [eq(clientAccounts.orgId, orgId)];
    if (role === SALES) f.push(eq(clientAccounts.salesRepId, userId));
    if (role === CUSTOMER_SUPPORT) f.push(eq(clientAccounts.assignedCrmId, userId));
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

  private sendNotificationEmail(to: string, title: string, message: string, link?: string): Promise<void> {
    return this.email.sendEmail({
      to,
      subject: `${title} — StreamlineOS`,
      html: notificationEmailHtml(title, message, link),
    });
  }

  private async sendInvestmentEmails(
    accountId: number,
    salesRepId: string,
    clientName: string,
    formattedAmount: string,
    hrUserIds: string[],
  ): Promise<void> {
    const [salesRep, hrUsers] = await Promise.all([
      this.db.query.users.findFirst({ where: eq(users.id, salesRepId), columns: { email: true, name: true } }),
      hrUserIds.length > 0
        ? this.db.select({ email: users.email }).from(users).where(inArray(users.id, hrUserIds))
        : Promise.resolve([] as { email: string | null }[]),
    ]);

    const sends: Promise<void>[] = [];
    if (salesRep?.email) {
      sends.push(
        this.sendNotificationEmail(
          salesRep.email,
          "Client Invested!",
          `${clientName} has invested ₹${formattedAmount}. Your incentive is being processed.`,
          `/crm/clients/${accountId}`,
        ),
      );
    }
    for (const hr of hrUsers) {
      if (!hr.email) continue;
      sends.push(
        this.sendNotificationEmail(
          hr.email,
          "Client Invested!",
          `${clientName} has invested ₹${formattedAmount}. Sales rep: ${salesRep?.name ?? "N/A"}.`,
          `/crm/clients/${accountId}`,
        ),
      );
    }
    await Promise.allSettled(sends);
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
      void this.sendInvestmentEmails(
        account.id,
        account.salesRepId,
        account.clientName,
        formattedAmount,
        hrMemberRows.map((m) => m.userId),
      ).catch(() => undefined);
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
      } catch {}
    }
    try {
      await this.backfillConvertedLeadsToClientAccounts(orgId, userId);
      await this.backfillCrmAssignments(orgId);
    } catch {}
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
