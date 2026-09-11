import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, and, desc, sql, count, or } from "drizzle-orm";
import type { DataScope } from "../access/access.types";
import { applyClientAccountsScope } from "./client-accounts-scope";
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
import {
  getCrmAssignmentStats,
  runCrmAssignments,
  tryBackfill,
  type ClientAccountBackfillDeps,
} from "./lib/client-account-backfill";
import { updateClientStatus, type ClientInvestmentDeps } from "./lib/client-investment";

/**
 * Client accounts: reading them, and the small writes that change one row.
 *
 * Two things that used to live here do not any more, and both left for the same
 * reason — they behave differently from everything else on this class.
 *
 * `lib/client-account-backfill.ts` holds the work that runs BESIDE a request:
 * opening accounts for converted leads and sharing unowned ones out round-robin,
 * fired off the list read with `void` behind a Redis lock, catching and logging
 * every failure so the list still renders. Everything below throws at the caller.
 *
 * `lib/client-investment.ts` holds the status change that pays somebody — the
 * only write here that fans out into incentives, notifications, an audit entry
 * and email, with a deliberate boundary about which of those may roll back.
 */
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

  private get backfillDeps(): ClientAccountBackfillDeps {
    return { db: this.db, redis: this.redis, access: this.access, logger: this.logger };
  }

  private get investmentDeps(): ClientInvestmentDeps {
    return {
      db: this.db,
      audit: this.audit,
      clientsEmail: this.clientsEmail,
      access: this.access,
    };
  }

  async getClientAccounts(
    orgId: string,
    scope: DataScope,
    userId: string,
    filters: ListAccountsInput,
  ) {
    void tryBackfill(this.backfillDeps, orgId, userId);

    const f = [eq(clientAccounts.orgId, orgId)];
    if (scope !== "all") f.push(applyClientAccountsScope(scope, orgId, userId));
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

  getClientAccount(orgId: string, id: number, scope: DataScope = "all", userId?: string) {
    return this.loadClientAccount(orgId, id, scope, userId);
  }

  private async loadClientAccount(
    orgId: string,
    id: number,
    scope: DataScope = "all",
    userId?: string,
  ) {
    const conditions = [eq(clientAccounts.id, id), eq(clientAccounts.orgId, orgId)];
    if (scope !== "all" && userId) {
      conditions.push(applyClientAccountsScope(scope, orgId, userId));
    }

    const account = await this.db.query.clientAccounts.findFirst({
      where: and(...conditions),
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

  listRenewals(orgId: string, scope: DataScope, userId: string) {
    const conditions = [eq(clientAccounts.orgId, orgId)];
    if (scope !== "all") {
      conditions.push(applyClientAccountsScope(scope, orgId, userId));
    }
    return this.db.query.clientAccounts.findMany({
      where: and(...conditions),
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

  /** See `lib/client-investment.ts`: the one status change that books money. */
  updateStatus(orgId: string, userId: string, accountId: number, input: UpdateClientStatusInput) {
    return updateClientStatus(this.investmentDeps, orgId, userId, accountId, input);
  }

  getCrmAssignmentStats(orgId: string) {
    return getCrmAssignmentStats(this.backfillDeps, orgId);
  }

  runCrmAssignments(orgId: string) {
    return runCrmAssignments(this.backfillDeps, orgId);
  }
}
