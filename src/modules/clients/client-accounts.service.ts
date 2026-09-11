import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, and, desc, sql, count, or } from "drizzle-orm";
import type { DataScope } from "../access/access.types";
import { applyClientAccountsScope } from "./client-accounts-scope";
import { Redis } from "@upstash/redis";
import { clientAccounts, clientAccountActivities } from "../../db/schema";
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
   *
   * See `lib/client-investment.ts`: the one status change that books money.
   */
  updateStatus(
    orgId: string,
    userId: string,
    accountId: number,
    input: UpdateClientStatusInput,
    scope: DataScope,
  ) {
    return updateClientStatus(this.investmentDeps, orgId, userId, accountId, input, scope);
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
  getCrmAssignmentStats(orgId: string) {
    return getCrmAssignmentStats(this.backfillDeps, orgId);
  }

  runCrmAssignments(orgId: string) {
    return runCrmAssignments(this.backfillDeps, orgId);
  }
}
