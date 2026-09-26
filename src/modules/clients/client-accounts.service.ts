import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { eq, and, desc, sql, count, or } from "drizzle-orm";
import type { ScopedRead } from "../access/scoped-read";
import { CLIENT_ACCOUNTS_SCOPE, clientAccountWhere } from "./client-accounts-scope";
import { Redis } from "@upstash/redis";
import { clientAccounts, clientAccountActivities } from "../../db/schema";
import { businessParties } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { REDIS } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
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
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

/**
 * Client accounts: reading them, and the small writes that change one row.
 *
 * Two things that used to live here do not any more, and both left for the same
 * reason — they behave differently from everything else on this class.
 *
 * `lib/client-account-backfill.ts` holds the work that runs BESIDE a request:
 * opening accounts for converted leads and sharing unowned ones out round-robin,
 * behind a Redis lock, deferred off the list read until that read's transaction
 * commits so a failing maintenance write cannot abort the read it rode in on.
 * Everything below throws at the caller.
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
    private readonly dispatch: NotificationDispatchService,
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
      dispatch: this.dispatch,
    };
  }

  async getClientAccounts(read: ScopedRead, filters: ListAccountsInput) {
    const orgId = read.orgId;
    // After the request's transaction commits: fired into it, a failing backfill
    // aborted the transaction and every later statement of this read answered 25P02.
    const backfill = () => tryBackfill(this.backfillDeps, orgId, read.actorId);
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
    const orgId = read.orgId;
    const account = await read.read(
      { tenant: clientAccounts.orgId, scope: CLIENT_ACCOUNTS_SCOPE, and: [eq(clientAccounts.id, id)] },
      ({ sql: where }) =>
        this.db.query.clientAccounts.findFirst({
          where,
          with: {
            salesRep: { columns: { id: true, name: true, image: true, email: true } },
            assignedCrm: { columns: { id: true, name: true, image: true, email: true } },
          },
        }),
      () => undefined,
    );
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
   * A miss is a 404, and it is the same 404 an account in another organisation
   * or outside the caller's scope gives, so this is not an oracle for which
   * accounts exist.
   */
  async getClientActivities(read: ScopedRead, clientAccountId: number) {
    const account = await this.db.query.clientAccounts.findFirst({
      where: clientAccountWhere(read, clientAccountId),
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
  async addActivity(read: ScopedRead, clientAccountId: number, input: CreateActivityInput) {
    const account = await this.db.query.clientAccounts.findFirst({
      where: clientAccountWhere(read, clientAccountId),
      columns: { id: true },
    });
    if (!account) return null;

    const [activity] = await this.db
      .insert(clientAccountActivities)
      .values({
        clientAccountId,
        userId: read.actorId,
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

  /**
   * Move an account's renewal, out of the accounts the caller may read.
   *
   * `listRenewals` ninety lines from here takes the read scope and narrows the
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
  async updateRenewal(read: ScopedRead, accountId: number, input: UpdateRenewalInput) {
    const where = clientAccountWhere(read, accountId);

    const existing = await this.db.query.clientAccounts.findFirst({
      where,
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
      .where(where)
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
  updateStatus(read: ScopedRead, accountId: number, input: UpdateClientStatusInput) {
    return updateClientStatus(this.investmentDeps, read, accountId, input);
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
