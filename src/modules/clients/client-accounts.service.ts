import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { eq, and, desc, sql, count, or } from "drizzle-orm";
import type { ScopedRead } from "../access/scoped-read";
import { CLIENT_ACCOUNTS_SCOPE } from "./client-accounts-scope";
import { Redis } from "@upstash/redis";
import { clientAccounts, clientAccountActivities } from "../../db/schema";
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
import { AccessService } from "../access/access.service";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { runClientAccountsBackfill } from "./client-accounts-backfill";
import {
  backfillCrmAssignments as runCrmAssignmentBackfill,
  getCrmAssignmentStats as readCrmAssignmentStats,
} from "./client-accounts-crm-assignment";
import {
  buildClientStatusUpdate,
  formatInvestmentAmount,
  isInvestmentTransition,
  recordInvestmentEffects,
} from "./client-accounts-investment";

@Injectable()
export class ClientAccountsService {
  private readonly logger = new Logger(ClientAccountsService.name);
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis | null,
    private readonly audit: AuditService,
    private readonly clientsEmail: ClientsEmailService,
    private readonly access: AccessService,
  ) {}

  async getClientAccounts(read: ScopedRead, filters: ListAccountsInput) {
    const orgId = read.orgId;
    const backfill = () =>
      runClientAccountsBackfill(
        { db: this.db, redis: this.redis, access: this.access, logger: this.logger },
        orgId,
        read.actorId,
      );
    if (!registerAfterCommit(backfill)) await backfill();

    const search = filters.search ? `%${filters.search}%` : undefined;
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 25;
    const offset = (page - 1) * limit;
    const empty = { accounts: [], totalCount: 0, page, totalPages: 0 };

    return read.read(
      {
        tenant: clientAccounts.orgId,
        scope: CLIENT_ACCOUNTS_SCOPE,
        and: [
          filters.status ? eq(clientAccounts.status, filters.status) : undefined,
          search
            ? or(
                sql`${clientAccounts.clientName} ILIKE ${search}`,
                sql`${clientAccounts.clientEmail} ILIKE ${search}`,
                sql`${clientAccounts.clientPhone} ILIKE ${search}`,
              )
            : undefined,
        ],
      },
      async ({ sql: where }) => {
        const [items, [countResult]] = await Promise.all([
          this.db.query.clientAccounts.findMany({
            where,
            orderBy: [desc(clientAccounts.createdAt)],
            limit,
            offset,
            with: {
              salesRep: { columns: { id: true, name: true, image: true } },
              assignedCrm: { columns: { id: true, name: true, image: true } },
            },
          }),
          this.db.select({ count: count() }).from(clientAccounts).where(where),
        ]);
        return {
          accounts: items,
          totalCount: countResult?.count ?? 0,
          page,
          totalPages: Math.ceil((countResult?.count ?? 0) / limit),
        };
      },
      () => empty,
    );
  }

  getClientAccount(read: ScopedRead, id: number) {
    return this.loadClientAccount(read, id);
  }

  private async loadClientAccount(read: ScopedRead, id: number) {
    const account = await read.read(
      { tenant: clientAccounts.orgId, scope: CLIENT_ACCOUNTS_SCOPE, and: [eq(clientAccounts.id, id)] },
      ({ sql: where }) =>
        this.db.query.clientAccounts.findFirst({
          where,
          with: {
            salesRep: { columns: { id: true, name: true, image: true, email: true } },
            assignedCrm: { columns: { id: true, name: true, image: true, email: true } },
            lead: { columns: { id: true, name: true, source: true, priority: true } },
          },
        }),
      () => undefined,
    );
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
    if (!account) throw new NotFoundException("Client account not found");

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

  listRenewals(read: ScopedRead) {
    return read.read(
      { tenant: clientAccounts.orgId, scope: CLIENT_ACCOUNTS_SCOPE },
      ({ sql: where }) => this.db.query.clientAccounts.findMany({
        where,
        with: { salesRep: { columns: { id: true, name: true } } },
        orderBy: (t, { asc }) => [asc(t.clientName)],
        limit: 100,
      }),
      () => [],
    );
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

    const updateData = buildClientStatusUpdate(input);
    const investmentAmount = input.investmentAmount;
    const recordInvestment = isInvestmentTransition(input);
    const formattedAmount = formatInvestmentAmount(investmentAmount);

    const hrMemberRows = recordInvestment
      ? await this.access.membersWithPermission(orgId, "hr:employees:manage")
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
        await recordInvestmentEffects(tx, {
          orgId,
          account,
          investmentAmount,
          formattedAmount,
          hrRecipientIds: hrMemberRows.map((hr) => hr.userId),
        });
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
        .catch(logSideEffectFailure("investment notification emails", { orgId, accountId }));
    }

    return updated;
  }

  async getCrmAssignmentStats(orgId: string) {
    return readCrmAssignmentStats(this.db, this.access, orgId);
  }

  async runCrmAssignments(orgId: string) {
    await runCrmAssignmentBackfill(this.db, this.access, orgId);
    return readCrmAssignmentStats(this.db, this.access, orgId);
  }
}
