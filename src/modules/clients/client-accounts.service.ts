import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { eq, and, desc, sql, count, or, inArray, isNull } from "drizzle-orm";
import type { DataScope } from "../access/access.types";
import { applyClientAccountsScope } from "./client-accounts-scope";
import { Redis } from "@upstash/redis";
import {
  clientAccounts,
  clientAccountActivities,
  incentives,
  incentiveConfig,
  notifications,
  users,
} from "../../db/schema";
import { businessParties } from "../../db/schema/party";
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

  async getClientAccounts(
    orgId: string,
    scope: DataScope,
    userId: string,
    filters: ListAccountsInput,
  ) {
    void this.tryBackfill(orgId, userId);

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
      },
    });
    if (!account) return null;

    /*
      The lead this account came from, read off Party.

      This was `with: { lead: {...} }`, resolving onto the `leads` table ticket
      08 dropped. Every column it asked for is a Party column and has been since
      phase 2 -- `source` is `acquisition_source`, `priority` is `priority`, and
      the mirror derived both from here. So the include was reading a copy.

      The projected shape does not change: `{ id, name, source, priority }` with
      `id` still the integer `lead_id`, which `lead_party_map` mints and this row
      still carries. The frontend's `lead?: { id; name; source; priority }` is
      unchanged.
    */
    const [lead] = account.leadPartyId
      ? await this.db
          .select({
            id: clientAccounts.leadId,
            name: businessParties.name,
            source: businessParties.acquisitionSource,
            priority: businessParties.priority,
          })
          .from(clientAccounts)
          .innerJoin(
            businessParties,
            and(
              eq(businessParties.organizationId, clientAccounts.orgId),
              eq(businessParties.partyId, account.leadPartyId),
            ),
          )
          .where(and(eq(clientAccounts.id, account.id), eq(clientAccounts.orgId, orgId)))
          .limit(1)
      : [];

    const activities = await this.db.query.clientAccountActivities.findMany({
      where: eq(clientAccountActivities.clientAccountId, id),
      orderBy: [desc(clientAccountActivities.createdAt)],
      with: { user: { columns: { id: true, name: true, image: true } } },
    });

    return { ...account, lead: lead ?? null, activities };
  }

  /**
   * One account's activity trail, behind the SAME scope the account itself is behind.
   *
   * `crm:clients:read` is declared `scopable: true`. `getClientAccounts` narrows,
   * `loadClientAccount` narrows, and `loadClientAccount` returns THIS EXACT
   * ACTIVITY LIST as part of the detail it narrows. This route returned it
   * unscoped, so the same rows were withheld on `/clients/:id` and handed over on
   * `/clients/:id/activities` — an organisation that had granted a rep `own` had
   * restricted the detail screen and not the tab inside it.
   *
   * An activity carries a title, a free-text description and a metadata blob
   * about a named customer, so the trail is the account in narrative form.
   *
   * The empty array on a miss is deliberate and unchanged: it is the same answer
   * an account with no activities gives and the same answer another org's
   * account gives, so this is not an oracle for which accounts exist.
   */
  async getClientActivities(
    orgId: string,
    clientAccountId: number,
    scope: DataScope,
    userId: string,
  ) {
    const conditions = [eq(clientAccounts.id, clientAccountId), eq(clientAccounts.orgId, orgId)];
    if (scope !== "all") conditions.push(applyClientAccountsScope(scope, orgId, userId));

    const account = await this.db.query.clientAccounts.findFirst({
      where: and(...conditions),
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

  /**
   * Write an activity onto an account the caller could have opened.
   *
   * The route is gated on `crm:clients:update`, which the catalog does not
   * declare scopable — but the record this attaches to is a READ, and §4 asks for
   * the object-level assertion on writes as much as on reads. Unscoped, a rep
   * restricted to their own book could append a note to the timeline of a
   * colleague's customer, where it reads afterwards as that colleague's own
   * record of the relationship.
   */
  async addActivity(
    orgId: string,
    clientAccountId: number,
    userId: string,
    input: CreateActivityInput,
    scope: DataScope,
  ) {
    const conditions = [eq(clientAccounts.id, clientAccountId), eq(clientAccounts.orgId, orgId)];
    if (scope !== "all") conditions.push(applyClientAccountsScope(scope, orgId, userId));

    const account = await this.db.query.clientAccounts.findFirst({
      where: and(...conditions),
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

  /**
   * Move an account's renewal, out of the accounts the caller may read.
   *
   * `listRenewals` ninety lines from here takes a `DataScope` and narrows the
   * renewals a rep is shown. This — the mutation reached from that very list —
   * took no caller id at all, so a rep granted `own` was shown six renewals and
   * could edit every renewal in the organisation by id.
   *
   * And it is a read as well as a write: `.returning()` names no columns, so the
   * response is the WHOLE `client_accounts` row — customer name, email, phone,
   * investment amount, plan, transaction reference, the assigned rep. A PATCH
   * that sets `renewalNotes` to what they already were was a working detail-read
   * for any account id, from a caller whose detail screen refused to open it.
   *
   * The scope is the READ scope, resolved from `crm:clients:read`, not from the
   * `crm:clients:update` key on the route — the catalog does not declare that one
   * scopable, and the question here is which record you may act on, which is the
   * same question as which record you may open.
   *
   * Both the check and the UPDATE carry the predicate. The check alone would
   * leave the write itself keyed on nothing but an id.
   */
  async updateRenewal(
    orgId: string,
    accountId: number,
    input: UpdateRenewalInput,
    scope: DataScope,
    userId: string,
  ) {
    const conditions = [eq(clientAccounts.id, accountId), eq(clientAccounts.orgId, orgId)];
    if (scope !== "all") conditions.push(applyClientAccountsScope(scope, orgId, userId));

    const existing = await this.db.query.clientAccounts.findFirst({
      where: and(...conditions),
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
      .where(and(...conditions))
      .returning();

    return updated;
  }

  /**
   * Change an account's status, out of the accounts the caller may read.
   *
   * The most expensive of the three writes on this service to leave open. It
   * reads the whole account row with no projection, and marking one INVESTED
   * mints an `incentives` row against `account.salesRepId` — SOMEBODY ELSE's
   * commission, calculated from an amount this caller typed — notifies that rep
   * that their client has invested, emails them and every HR manager, and returns
   * the full account row to the caller. A rep restricted to their own book could
   * do all of that to a colleague's customer by id, and the only trace pointing
   * at them is the audit entry.
   *
   * Same reasoning as `updateRenewal`: the route's `crm:clients:update` key is not
   * scopable, but which record you may act on is the same question as which
   * record you may open, and that is `crm:clients:read`.
   */
  async updateStatus(
    orgId: string,
    userId: string,
    accountId: number,
    input: UpdateClientStatusInput,
    scope: DataScope,
  ) {
    const conditions = [eq(clientAccounts.id, accountId), eq(clientAccounts.orgId, orgId)];
    if (scope !== "all") conditions.push(applyClientAccountsScope(scope, orgId, userId));

    const account = await this.db.query.clientAccounts.findFirst({
      where: and(...conditions),
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
      ? await this.access.membersWithPermission(orgId, "hr:employees:manage")
      : [];

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(clientAccounts)
        .set(updateData)
        .where(and(...conditions))
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
        .catch(logSideEffectFailure("investment notification emails", { orgId, accountId }));
    }

    return updated;
  }

  /**
   * Deliberately NOT narrowed by `DataScope`, and here is why.
   *
   * A census flags this the same way it flags the three above: gated on
   * `crm:clients:read`, which is `scopable: true`, and takes no caller id. It is
   * a different thing, and narrowing it would break it rather than fix it.
   *
   * The figure is how many accounts each customer-success member is carrying,
   * and it exists to be read immediately before `POST /clients/assign-crm`
   * rebalances them. Put `sales_rep_id = me` through it and it answers "how many
   * of MY accounts is each CS member carrying", which is not a question any
   * screen asks and is not the quantity the round-robin below balances against.
   * A number that becomes meaningless when narrowed is not narrowed.
   *
   * What it discloses is bounded and is not customer data: the CS members' names
   * and images — the people directory is a universal read — plus a count per
   * member and a count of unassigned accounts. No client identity, no contact
   * details, no money.
   *
   * The real asymmetry here is the GATE, not the scope: the read is on
   * `crm:clients:read` while the assignment it precedes is on
   * `crm:clients:manage`, so a restricted rep can see the organisation's staffing
   * load without being able to act on it. Raising the read to the manage key is a
   * product decision that would 403 whoever opens the screen today, so it is
   * recorded here rather than taken in a scope fix.
   */
  async getCrmAssignmentStats(orgId: string) {
    const csMemberIds = (await this.access.membersWithPermission(orgId, "support:tickets:manage", { limit: 500 })).map((m) => m.userId);

    if (csMemberIds.length === 0) {
      return { members: [], unassignedCount: 0 };
    }

    const csMembers = await this.db
      .select({ userId: users.id, name: users.name, image: users.image })
      .from(users)
      .where(inArray(users.id, csMemberIds));

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

  /**
   * Opens a client account for every lead that has converted and has none.
   *
   * Reads Party, not `leads`. This was raw SQL against the legacy table, which
   * neither the reader ratchet nor the lint rule could see -- both match Drizzle
   * symbol imports, and a string never imports anything. So it survived every
   * migrate batch, and ticket 08's drop would have taken it out at runtime with
   * nothing having warned.
   *
   * The read is not merely relocated. `leads` is a mirror, and a merge leaves the
   * losing row alive holding the survivor's values while marking only the Party
   * deleted -- so `FROM leads WHERE deleted_at IS NULL` counted one converted
   * customer twice and opened two accounts for them. Joining through
   * `lead_party_map` and filtering on the Party's own `deleted_at` counts the
   * customer.
   *
   * The map is keyed by legacy id and its `party_id` side is deliberately not
   * unique -- after a merge several ids answer to one Party. That is correct
   * here rather than a hazard: `client_accounts.lead_id` is the legacy id, the
   * anti-join is on that id, so each surviving id still gets exactly one account.
   */
  private async backfillConvertedLeadsToClientAccounts(orgId: string, fallbackSalesRepId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO client_accounts (
        org_id, lead_id, sales_rep_id,
        client_name, client_email, client_phone, client_whatsapp,
        estimated_investment, status, converted_at, created_at, updated_at
      )
      SELECT
        m.organization_id,
        m.lead_id,
        COALESCE(p.owner_user_id, ${fallbackSalesRepId}),
        p.name,
        p.email,
        p.phone,
        p.whatsapp_phone,
        COALESCE(p.expected_value, p.stated_budget)::numeric(15,2),
        'ACCOUNT_OPENING'::text,
        COALESCE(p.converted_at, NOW()),
        NOW(),
        NOW()
      FROM lead_party_map m
      JOIN business_parties p
        ON p.party_id = m.party_id
       AND p.organization_id = m.organization_id
      WHERE m.organization_id = ${orgId}
        AND p.lifecycle_stage = 'CONVERTED'
        AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM client_accounts ca
          WHERE ca.org_id = m.organization_id AND ca.lead_id = m.lead_id
        )
    `);
  }

  private async backfillCrmAssignments(orgId: string): Promise<void> {
    const csMembers = await this.access.membersWithPermission(orgId, "support:tickets:manage", { limit: 500 });

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
