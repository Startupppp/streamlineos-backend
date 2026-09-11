import {
  BadRequestException,
  ConflictException,
  Injectable,
  type HttpException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  organizationAllowedEmailDomains,
  organizationMembers,
  users,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { MembershipMutations } from "../../../common/org/membership-mutations";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { lockMembersQuota } from "../../billing/core/seat-definition";

export const ALREADY_MEMBER_MESSAGE = "User is already a member of this organization";

export const ARCHIVED_MEMBER_MESSAGE =
  "This person was archived/suspended in this organization. Restore them from Users instead of inviting again.";

export const DUPLICATE_ADMISSION_EMAIL_MESSAGE = "Duplicate email in this upload";

export type AdmissionUserDraft = Omit<typeof users.$inferInsert, "id" | "email">;

export interface AdmissionActor {
  userId: string;
}

export interface AdmissionClearance {
  kind: "clear";
  userId: string | null;
}

export interface AdmissionNeedsRestore {
  kind: "needs-restore";
  userId: string;
  status: "SUSPENDED" | "LEFT";
}

export interface AdmissionConflict {
  kind: "conflict";
  reason: "already-member" | "duplicate-in-batch" | "email-domain-not-allowed";
  message: string;
}

export interface AdmissionAdmitted {
  kind: "admitted";
  userId: string;
  membershipId: number | null;
  createdUser: boolean;
}

export type AdmissionRefusal = AdmissionNeedsRestore | AdmissionConflict;
export type AdmissionScreen = AdmissionClearance | AdmissionRefusal;
export type AdmissionOutcome = AdmissionAdmitted | AdmissionRefusal;

export interface AdmitOneInput {
  orgId: string;
  email: string;
  role: string;
  actor: AdmissionActor;
  createUserIfMissing: AdmissionUserDraft | null;
  membership: MembershipMutations;
  seatReason?: string;
}

export interface AdmissionCandidate {
  email: string;
  role: string;
  screen: AdmissionScreen;
  createUserIfMissing: AdmissionUserDraft | null;
}

export interface AdmitManyInput {
  orgId: string;
  actor: AdmissionActor;
  candidates: readonly AdmissionCandidate[];
  membership: MembershipMutations;
  seatReason?: string;
}

interface AllowedEmailDomains {
  listed: readonly string[];
  permitted: ReadonlySet<string>;
}

interface ClearedAdmission {
  index: number;
  email: string;
  role: string;
  userId: string;
  draft: AdmissionUserDraft | null;
}

export function admissionRefusalMessage(refusal: AdmissionRefusal): string {
  return refusal.kind === "needs-restore" ? ARCHIVED_MEMBER_MESSAGE : refusal.message;
}

export function admissionFailure(refusal: AdmissionRefusal): HttpException {
  if (refusal.kind === "conflict" && refusal.reason === "email-domain-not-allowed")
    return new BadRequestException(refusal.message);
  return new ConflictException(admissionRefusalMessage(refusal));
}

export function canonicalAdmissionEmail(value: string): string {
  return value.trim().toLowerCase();
}

function refuseDomain(email: string, domains: AllowedEmailDomains): AdmissionConflict | null {
  if (domains.permitted.size === 0) return null;
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (domain && domains.permitted.has(domain)) return null;
  return {
    kind: "conflict",
    reason: "email-domain-not-allowed",
    message: `Email domain not allowed. Permitted: ${domains.listed.join(", ")}`,
  };
}

/**
 * The one answer to "may this person join this organisation, and what does joining cost".
 *
 * Screening is a read and admission is a write, so they are separate calls: a batch
 * caller has to plan between the two, and `admitMany` therefore takes the clearance
 * `screenMany` produced rather than re-reading it. `admitOne` composes both halves.
 * Either way the seat lock is taken once and `assertWithinLimit` is asked once, for
 * the whole set.
 */
@Injectable()
export class MembershipAdmissionService {
  constructor(
    private readonly planLimits: PlanLimitsService,
    private readonly seatLedger: SeatLedgerService,
  ) {}

  async screen(
    executor: DbOrTx,
    input: { orgId: string; email: string },
  ): Promise<AdmissionScreen> {
    const email = canonicalAdmissionEmail(input.email);
    const domains = await this.loadAllowedDomains(executor, input.orgId);
    const refusal = refuseDomain(email, domains);
    if (refusal) return refusal;

    const account = await executor.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });
    if (!account) return { kind: "clear", userId: null };

    const member = await executor.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, input.orgId),
        eq(organizationMembers.userId, account.id),
      ),
      columns: { status: true },
    });
    if (!member) return { kind: "clear", userId: account.id };
    if (member.status === "SUSPENDED" || member.status === "LEFT")
      return { kind: "needs-restore", userId: account.id, status: member.status };
    return { kind: "conflict", reason: "already-member", message: ALREADY_MEMBER_MESSAGE };
  }

  /** The batch form: three org-scoped statements for the whole upload instead of three per row. */
  async screenMany(
    executor: DbOrTx,
    input: { orgId: string; emails: readonly string[] },
  ): Promise<Map<string, AdmissionScreen>> {
    const emails = [...new Set(input.emails.map(canonicalAdmissionEmail))];
    const screens = new Map<string, AdmissionScreen>();
    if (emails.length === 0) return screens;

    const domains = await this.loadAllowedDomains(executor, input.orgId);
    const permitted: string[] = [];
    for (const email of emails) {
      const refusal = refuseDomain(email, domains);
      if (refusal) screens.set(email, refusal);
      else permitted.push(email);
    }
    if (permitted.length === 0) return screens;

    const accounts = await executor
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, permitted))
      .limit(permitted.length);

    const userIdByEmail = new Map(
      accounts.map((account) => [canonicalAdmissionEmail(account.email), account.id]),
    );
    const statusByUserId = new Map<string, string>();
    const userIds = [...userIdByEmail.values()];
    if (userIds.length > 0) {
      const members = await executor
        .select({
          userId: organizationMembers.userId,
          status: organizationMembers.status,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, input.orgId),
            inArray(organizationMembers.userId, userIds),
          ),
        )
        .limit(userIds.length);
      for (const member of members) statusByUserId.set(member.userId, member.status);
    }

    for (const email of permitted) {
      const userId = userIdByEmail.get(email);
      if (userId === undefined) {
        screens.set(email, { kind: "clear", userId: null });
        continue;
      }
      const status = statusByUserId.get(userId);
      if (status === undefined) {
        screens.set(email, { kind: "clear", userId });
        continue;
      }
      if (status === "SUSPENDED" || status === "LEFT") {
        screens.set(email, { kind: "needs-restore", userId, status });
        continue;
      }
      screens.set(email, {
        kind: "conflict",
        reason: "already-member",
        message: ALREADY_MEMBER_MESSAGE,
      });
    }

    return screens;
  }

  async admitOne(tx: DbOrTx, input: AdmitOneInput): Promise<AdmissionOutcome> {
    const email = canonicalAdmissionEmail(input.email);
    const screen = await this.screen(tx, { orgId: input.orgId, email });
    const [outcome] = await this.admitMany(tx, {
      orgId: input.orgId,
      actor: input.actor,
      membership: input.membership,
      seatReason: input.seatReason,
      candidates: [
        { email, role: input.role, screen, createUserIfMissing: input.createUserIfMissing },
      ],
    });
    if (!outcome) throw new Error("Admission returned no outcome for a single candidate");
    return outcome;
  }

  async admitMany(tx: DbOrTx, input: AdmitManyInput): Promise<AdmissionOutcome[]> {
    const outcomes: AdmissionOutcome[] = [];
    const cleared: ClearedAdmission[] = [];
    const seenEmails = new Set<string>();

    input.candidates.forEach((candidate, index) => {
      const email = canonicalAdmissionEmail(candidate.email);
      if (seenEmails.has(email)) {
        outcomes[index] = {
          kind: "conflict",
          reason: "duplicate-in-batch",
          message: DUPLICATE_ADMISSION_EMAIL_MESSAGE,
        };
        return;
      }
      seenEmails.add(email);
      const screen = candidate.screen;
      if (screen.kind !== "clear") {
        outcomes[index] = screen;
        return;
      }
      const userId = screen.userId;
      if (userId === null && candidate.createUserIfMissing === null)
        throw new Error(`No account exists for ${email} and no user record was supplied`);
      cleared.push({
        index,
        email,
        role: candidate.role,
        userId: userId ?? randomUUID(),
        draft: userId === null ? candidate.createUserIfMissing : null,
      });
    });

    if (cleared.length === 0) return outcomes;

    await tx.execute(lockMembersQuota(input.orgId));
    await this.planLimits.assertWithinLimit(input.orgId, "members", cleared.length, tx);

    const drafted = cleared.filter(
      (entry): entry is ClearedAdmission & { draft: AdmissionUserDraft } => entry.draft !== null,
    );
    if (drafted.length > 0)
      await tx
        .insert(users)
        .values(
          drafted.map((entry) => ({ ...entry.draft, id: entry.userId, email: entry.email })),
        );

    const membershipIdByUserId = await this.createMemberships(tx, input, cleared);

    await this.seatLedger.recordSeatEvents(
      tx,
      input.orgId,
      cleared.map((entry) => ({
        eventType: "INVITE_ACCEPTED" as const,
        subjectId: entry.userId,
        actorId: input.actor.userId,
        reason: input.seatReason ?? "member admitted",
        idempotencyKey: `member-added:${input.orgId}:${entry.userId}`,
      })),
    );

    for (const entry of cleared)
      outcomes[entry.index] = {
        kind: "admitted",
        userId: entry.userId,
        membershipId: membershipIdByUserId.get(entry.userId) ?? null,
        createdUser: entry.draft !== null,
      };

    return outcomes;
  }

  /** A racing admission for the same person is a 409, never an unhandled 23505. */
  private async createMemberships(
    tx: DbOrTx,
    input: AdmitManyInput,
    cleared: readonly ClearedAdmission[],
  ): Promise<Map<string, number>> {
    try {
      return await input.membership.createMemberships(tx, {
        orgId: input.orgId,
        members: cleared.map((entry) => ({ userId: entry.userId, role: entry.role })),
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(ALREADY_MEMBER_MESSAGE);
      throw err;
    }
  }

  private async loadAllowedDomains(
    executor: DbOrTx,
    orgId: string,
  ): Promise<AllowedEmailDomains> {
    const rows = await executor
      .select({ domain: organizationAllowedEmailDomains.domain })
      .from(organizationAllowedEmailDomains)
      .where(eq(organizationAllowedEmailDomains.orgId, orgId))
      .limit(100);
    const listed = rows.map((row) => row.domain.trim()).filter((domain) => domain.length > 0);
    return {
      listed,
      permitted: new Set(listed.map((domain) => domain.toLowerCase())),
    };
  }
}
