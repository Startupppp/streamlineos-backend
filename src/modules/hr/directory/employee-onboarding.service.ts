import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import {
  hrEmployments,
  hrPeople,
  magicLinkTokens,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import { hashToken } from "../../../common/security/token.util";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { EmailService } from "../../email/email.service";
import { appUrl } from "../../email/app-url";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import { syncCanonicalEmploymentFields } from "../../../common/hr/sync-canonical-employment-fields";
import { formatDateOnly } from "../../../common/date";
import { seedEmployeeSalaryProfile } from "./salary-profile-seed.helper";
import type { OnboardEmployeeInput } from "./dto/hr-directory.schemas";
import type { InviteDelivery } from "./dto/directory-response.schemas";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { AccessService } from "../../access/access.service";
import { syncOrgUnitPlacement } from "../../../common/org/sync-org-unit-placement";
import {
  withMembershipMutations,
  type MembershipMutations,
} from "../../../common/org/membership-mutations";
import {
  MembershipAdmissionService,
  admissionFailure,
  canonicalAdmissionEmail,
  type AdmissionUserDraft,
} from "../../organization/core/membership-admission.service";
import {
  ALREADY_EMPLOYEE_MESSAGE,
  ATTACH_CONFIRMATION_REQUIRED_MESSAGE,
  findLivePrimaryEmploymentId,
} from "./employee-admission-status";
import { resolveOrgSalaryCurrency } from "./employment-salary-currency";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import { ReportingManagerFallbackResolver } from "../../directory/reporting-manager-fallback.resolver";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import { assignOnboardingManager, writeOnboardingSensitiveFields } from "./employee-onboarding-relationships";
import { EMPLOYEES_VIEW_PERMISSION } from "./employees-scope";
import { invalidateReportingReads } from "../../directory/reporting-line-cache";
import { resolvePersonDisplayName } from "../../../common/organization/person-display-name";

const EMP_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const INVITE_TOKEN_DAYS = 7;

export const EMPLOYEE_NOT_FOUND_MESSAGE = "Employee not found in this organization.";

export const SUSPENDED_ACCOUNT_MESSAGE =
  "This account is globally suspended. Contact platform support to restore it before adding to an organization.";

export function alreadyMemberInviteReason(organizationName: string): string {
  return `Already a member of ${organizationName}, so no invitation was needed.`;
}

type InviteKind = "welcome" | "membership-added";

function randomEmployeeCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += EMP_CODE_ALPHABET[bytes[i] % EMP_CODE_ALPHABET.length];
  return out;
}

@Injectable()
export class EmployeeOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly webhooks: WebhooksDispatchService,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
    private readonly access: AccessService,
    private readonly admission: MembershipAdmissionService,
    private readonly relationships: ReportingRelationshipService,
    private readonly fallback: ReportingManagerFallbackResolver,
    private readonly hierarchyCache: OrgHierarchyCacheService,
  ) {}

  async onboardEmployee(actor: CurrentUserContext, body: OnboardEmployeeInput) {
    const resolvedEmployeeId = body.employeeId?.trim() || `EMP-${randomEmployeeCode(6)}`;
    const role = body.role || ORG_MEMBER_ROLES.MEMBER;
    await assertMayGrantRole(this.access, actor.orgId, actor, role);
    const dateOfBirth = body.dateOfBirth ? formatDateOnly(body.dateOfBirth) : undefined;
    const joiningDate = body.joiningDate ? formatDateOnly(body.joiningDate) : null;
    // Ticket 07: one policy composes the account name, the same one the
    // directory, the CSV export and the profile PDF display.
    const fullName =
      resolvePersonDisplayName({
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
      }) ?? body.email;

    const salaryCurrency =
      body.monthlySalary === undefined
        ? null
        : await resolveOrgSalaryCurrency(this.db, actor.orgId);

    const admitted = await withMembershipMutations(this.cache, (membership) =>
      runInTenantTransaction(
        this.db,
        async (tx) => {
          const outcome = await this.resolveSubject(tx, {
            orgId: actor.orgId,
            email: body.email,
            role,
            actor,
            membership,
            attachToExistingMember: body.attachToExistingMember === true,
            createUserIfMissing: {
              name: fullName,
              firstName: body.firstName,
              lastName: body.lastName,
              phone: body.phone,
              whatsappNumber: body.whatsappSameAsPhone
                ? body.phone
                : body.whatsappNumber,
              gender: body.gender,
              dateOfBirth,
              isActive: true,
            },
          });

          if (!outcome.createdUser) {
            const [account] = await tx
              .select({ isActive: users.isActive })
              .from(users)
              .where(eq(users.id, outcome.userId))
              .limit(1);
            if (account?.isActive === false) throw new BadRequestException(SUSPENDED_ACCOUNT_MESSAGE);
          }

          if (body.employeeId?.trim()) {
            const [duplicate] = await tx
              .select({ userId: hrPeople.userId })
              .from(hrEmployments)
              .innerJoin(
                hrPeople,
                and(eq(hrPeople.orgId, actor.orgId), eq(hrPeople.id, hrEmployments.personId)),
              )
              .where(
                and(
                  eq(hrEmployments.orgId, actor.orgId),
                  eq(hrEmployments.employeeNumber, resolvedEmployeeId),
                ),
              )
              .limit(1);
            if (duplicate && duplicate.userId !== outcome.userId)
              throw new ConflictException(
                `Employee ID "${resolvedEmployeeId}" is already in use in your organization.`,
              );
          }

          await syncOrgUnitPlacement(tx, actor.orgId, outcome.userId, {
            DEPARTMENT: body.departmentId,
          });

          if (body.monthlySalary && body.monthlySalary > 0 && salaryCurrency)
            await seedEmployeeSalaryProfile(tx, {
              orgId: actor.orgId,
              userId: outcome.userId,
              actorId: actor.userId,
              monthlySalary: body.monthlySalary,
              currency: salaryCurrency,
              effectiveFrom: joiningDate ?? formatDateOnly(new Date()),
              salaryStructureTemplateId: body.salaryStructureTemplateId,
            });

          // HRM-15: the employment, its fields and its reporting relationships are written in the
          // same transaction as the admission, so a refused manager or a missing fallback leaves no
          // half-onboarded employee behind.
          const ensured = await this.personEmploymentSync.ensureFromUser(
            actor.orgId,
            actor.userId,
            {
              userId: outcome.userId,
              firstName: body.firstName,
              lastName: body.lastName,
              workEmail: body.email,
              employeeNumber: resolvedEmployeeId,
              joiningDate,
              designation: body.designation ?? null,
              phone: body.phone ?? null,
              lifecycleStatus: "ONBOARDING",
            },
            tx,
          );
          if (body.departmentId)
            await syncCanonicalEmploymentFields(tx, actor.orgId, outcome.userId, { departmentId: body.departmentId });
          await writeOnboardingSensitiveFields(tx, actor.orgId, ensured.employmentId, body, salaryCurrency);
          const primaryManager = await assignOnboardingManager(
            { db: this.db, relationships: this.relationships, fallback: this.fallback },
            tx,
            actor,
            { employeeUserId: outcome.userId, body, joiningDate },
          );

          return { ...outcome, primaryManager };
        },
        { orgId: actor.orgId },
      ),
    );

    // BE-82: automations run in their own transaction once this one has committed, never on a
    // request transaction that may be closed by the time they query.
    const startAutomations = async (): Promise<void> =>
      this.automation.runAutomationsForEventDetached(actor.orgId, "onboarding.started", {
        userId: admitted.userId,
        employeeName: fullName.trim(),
        employeeEmail: body.email,
        departmentId: body.departmentId ?? null,
        joiningDate: body.joiningDate ?? null,
        startedAt: new Date().toISOString(),
      });
    if (!registerAfterCommit(startAutomations)) await startAutomations();

    if (admitted.createdUser)
      this.webhooks.dispatch(actor.orgId, "employee.hired", {
        userId: admitted.userId,
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        joiningDate: body.joiningDate ?? null,
      });

    const organizationName = await this.organizationName(actor.orgId);
    const invite: InviteDelivery = admitted.attached
      ? { sent: false, reason: alreadyMemberInviteReason(organizationName) }
      : await this.queueInvite({
          orgId: actor.orgId,
          organizationName,
          userId: admitted.userId,
          email: body.email,
          name: fullName.trim(),
          kind: admitted.createdUser ? "welcome" : "membership-added",
        });

    await this.audit.logCritical({
      action: "hr.employee_onboarded",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: admitted.userId,
      targetType: "employee",
      metadata: {
        email: body.email,
        name: fullName,
        role: body.role,
        designation: body.designation,
        invite,
        ...(admitted.createdUser ? {} : { linked: true }),
        ...(admitted.attached ? { attachedToExistingMember: true } : {}),
        ...(body.reportingManagerUserId ? { reportingManagerUserId: body.reportingManagerUserId } : {}),
        ...(body.topLevelRole ? { topLevelRole: true, topLevelRoleReason: body.topLevelRoleReason ?? null } : {}),
        primaryManagerResolution: admitted.primaryManager?.resolution ?? null,
      },
    });

    const orgId = actor.orgId;
    const afterCommitWork = (): Promise<void> => this.invalidateHrDashboardCache(orgId);
    if (!registerAfterCommit(afterCommitWork)) await afterCommitWork();
    await invalidateReportingReads(this.hierarchyCache, this.cache, orgId);

    const showResolution = await this.access.holds(actor, EMPLOYEES_VIEW_PERMISSION);
    const primaryManager = admitted.primaryManager
      ? {
          userId: admitted.primaryManager.userId,
          name: admitted.primaryManager.name,
          ...(showResolution ? { resolution: admitted.primaryManager.resolution } : {}),
        }
      : null;
    return { success: true, userId: admitted.userId, invite, primaryManager };
  }

  async resendInvite(
    actor: CurrentUserContext,
    employeeUserId: string,
  ): Promise<{ success: true; invite: InviteDelivery }> {
    const [target] = await this.db
      .select({
        email: users.email,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        isActive: users.isActive,
        emailVerified: users.emailVerified,
        membershipStatus: organizationMembers.status,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, employeeUserId),
        ),
      )
      .limit(1);
    if (!target || target.membershipStatus !== "ACTIVE")
      throw new NotFoundException(EMPLOYEE_NOT_FOUND_MESSAGE);
    if (!target.isActive) throw new BadRequestException(SUSPENDED_ACCOUNT_MESSAGE);

    const name =
      resolvePersonDisplayName({
        firstName: target.firstName,
        lastName: target.lastName,
        accountName: target.name,
        email: target.email,
      }) ?? target.email;
    const invite = await this.queueInvite({
      orgId: actor.orgId,
      organizationName: await this.organizationName(actor.orgId),
      userId: employeeUserId,
      email: target.email,
      name,
      kind: target.emailVerified === null ? "welcome" : "membership-added",
    });

    await this.audit.logCritical({
      action: "hr.employee_invite_resent",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: employeeUserId,
      targetType: "employee",
      metadata: { email: target.email, invite },
    });

    return { success: true, invite };
  }

  /**
   * HRMS-E2E-001b. A single-use join link an administrator can hand over
   * directly.
   *
   * The invite has exactly one delivery route today: an email. When the provider
   * is unconfigured, the domain unverified, or the message silently dropped —
   * all three happened in the environment QA tested — there is no second way in,
   * and onboarding stops for the whole organisation with nothing on screen
   * saying why. This gives an administrator the link the email would have
   * carried, so a new hire can be let in by any channel the two of them already
   * trust.
   *
   * It is the same kind of token the email carries, not a weaker one: hashed at
   * rest, single-use, seven-day TTL, and minting it retires every earlier link
   * for that person. Handing it out is a privileged act, so it needs the
   * onboarding permission and is recorded in the critical audit log with the
   * actor — the log says who took a link and when, which is what makes this
   * answerable later.
   *
   * The raw token exists only in the response. It is never logged, and the
   * caller is expected to hand it over rather than store it.
   */
  async createInviteLink(
    actor: CurrentUserContext,
    employeeUserId: string,
  ): Promise<{ inviteUrl: string; expiresAt: string; email: string }> {
    const [target] = await this.db
      .select({
        email: users.email,
        isActive: users.isActive,
        membershipStatus: organizationMembers.status,
        isOwner: organizationMembers.isOwner,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, actor.orgId),
          eq(organizationMembers.userId, employeeUserId),
        ),
      )
      .limit(1);

    if (!target || target.membershipStatus !== "ACTIVE")
      throw new NotFoundException(EMPLOYEE_NOT_FOUND_MESSAGE);
    if (!target.isActive) throw new BadRequestException(SUSPENDED_ACCOUNT_MESSAGE);
    if (target.isOwner && !actor.isOrgOwner)
      throw new ForbiddenException(
        "Only the organization owner may take a sign-in link for the organization owner",
      );

    const rawToken = randomBytes(32).toString("hex");
    const expiresAt = addDays(new Date(), INVITE_TOKEN_DAYS);
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx
          .update(magicLinkTokens)
          .set({ usedAt: new Date() })
          .where(and(eq(magicLinkTokens.userId, employeeUserId), isNull(magicLinkTokens.usedAt)));
        await tx.insert(magicLinkTokens).values({
          id: randomUUID(),
          userId: employeeUserId,
          tokenHash: hashToken(rawToken),
          expiresAt,
        });
      },
      { orgId: actor.orgId },
    );

    await this.audit.logCritical({
      action: "hr.employee_invite_link_taken",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: employeeUserId,
      targetType: "employee",
      // The address, never the token: this row is the answer to "who took a link
      // for whom", and a raw token in an audit row is a credential at rest.
      metadata: { email: target.email, expiresAt: expiresAt.toISOString() },
    });

    return {
      inviteUrl: `${appUrl()}/magic-link?token=${rawToken}`,
      expiresAt: expiresAt.toISOString(),
      email: target.email,
    };
  }

  private async organizationName(orgId: string): Promise<string> {
    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new NotFoundException("Organization not found.");
    return org.name;
  }

  private async queueInvite(input: {
    orgId: string;
    organizationName: string;
    userId: string;
    email: string;
    name: string;
    kind: InviteKind;
  }): Promise<InviteDelivery> {
    // Issuing a new invite retires the ones before it. Each resend used to mint
    // another token and leave every earlier one live until its seven-day expiry,
    // so a link forwarded on Monday still worked after Friday's resend was sent
    // to correct it — and an invite recalled by resending was not recalled at
    // all. Retiring and issuing in one transaction means a failure here cannot
    // leave the person with no working link.
    //
    // V-030. The enqueue used to sit AFTER this transaction committed, with an
    // UPDATE on `this.db` compensating when it failed. That is atomicity by
    // apology: a crash between the commit and the enqueue left a live invite
    // token nobody was ever mailed, and the compensating update could itself
    // fail. `this.db` is the tenant-aware proxy, so `EmailOutboxService` writes
    // its row on whatever transaction is ambient — enqueueing from inside this
    // callback puts the outbox row and the token in ONE transaction. Neither
    // enqueueOnly nor its suppression check makes a network call, so this does
    // not hold a pooled connection through a provider outage (BE-84).
    const rawToken = randomBytes(32).toString("hex");
    const tokenId = randomUUID();
    const signInUrl = `${appUrl()}/magic-link?token=${rawToken}`;

    return runInTenantTransaction(
      this.db,
      async (tx): Promise<InviteDelivery> => {
        await tx
          .update(magicLinkTokens)
          .set({ usedAt: new Date() })
          .where(and(eq(magicLinkTokens.userId, input.userId), isNull(magicLinkTokens.usedAt)));
        await tx.insert(magicLinkTokens).values({
          id: tokenId,
          userId: input.userId,
          tokenHash: hashToken(rawToken),
          expiresAt: addDays(new Date(), INVITE_TOKEN_DAYS),
        });

        const outcome =
          input.kind === "welcome"
            ? await this.email.queueWelcomeEmail({
                organizationId: input.orgId,
                recipientUserId: input.userId,
                email: input.email,
                name: input.name,
                setupUrl: signInUrl,
              })
            : await this.email.queueMembershipAddedEmail({
                organizationId: input.orgId,
                recipientUserId: input.userId,
                email: input.email,
                name: input.name,
                organizationName: input.organizationName,
                signInUrl,
              });
        if (outcome.queued) return { sent: true, reason: null };

        // Not a compensation any more — the same transaction. A suppressed or
        // unsendable address is a reported outcome, not a failure, so the
        // earlier invites stay retired and the undeliverable token is retired
        // with them rather than leaving a link nobody was sent.
        await tx
          .update(magicLinkTokens)
          .set({ usedAt: new Date() })
          .where(eq(magicLinkTokens.id, tokenId));
        return { sent: false, reason: outcome.reason };
      },
      { orgId: input.orgId },
    );
  }

  private async resolveSubject(
    tx: Db,
    input: {
      orgId: string;
      email: string;
      role: string;
      actor: CurrentUserContext;
      membership: MembershipMutations;
      attachToExistingMember: boolean;
      createUserIfMissing: AdmissionUserDraft;
    },
  ): Promise<{ userId: string; createdUser: boolean; attached: boolean }> {
    const email = canonicalAdmissionEmail(input.email);
    const screen = await this.admission.screen(tx, { orgId: input.orgId, email });

    if (screen.kind === "conflict" && screen.reason === "already-member") {
      const existingUserId = screen.userId;
      if (existingUserId === undefined) throw admissionFailure(screen);
      if (!input.attachToExistingMember)
        throw new ConflictException(ATTACH_CONFIRMATION_REQUIRED_MESSAGE);
      const employmentId = await findLivePrimaryEmploymentId(tx, input.orgId, existingUserId);
      if (employmentId !== null) throw new ConflictException(ALREADY_EMPLOYEE_MESSAGE);
      return { userId: existingUserId, createdUser: false, attached: true };
    }

    const [outcome] = await this.admission.admitMany(tx, {
      orgId: input.orgId,
      actor: input.actor,
      membership: input.membership,
      seatReason: "employee onboarded",
      candidates: [
        {
          email,
          role: input.role,
          screen,
          createUserIfMissing: input.createUserIfMissing,
        },
      ],
    });
    if (!outcome) throw new InternalServerErrorException(`Admission did not complete for ${email}.`);
    if (outcome.kind !== "admitted") throw admissionFailure(outcome);
    return { userId: outcome.userId, createdUser: outcome.createdUser, attached: false };
  }

  private async invalidateHrDashboardCache(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespaceForOrg(orgId, "hr:analytics"),
      this.cache.invalidate(`hr:dashboard:metrics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:headcount-trends:${orgId}`),
      this.cache.invalidateNamespaceForOrg(orgId, "hr:celebrations"),
      this.cache.invalidateNamespace(CACHE_KEYS.hrEmployeesListNamespace(orgId)),
    ]);
  }
}
