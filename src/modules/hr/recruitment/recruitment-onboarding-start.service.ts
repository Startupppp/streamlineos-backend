import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  candidates,
  hrEmployments,
  hrPeople,
  organizationPeople,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import {
  MembershipAdmissionService,
  canonicalAdmissionEmail,
} from "../../organization/core/membership-admission.service";
import {
  OnboardingInitiationService,
  isInitiateAlreadyDone,
} from "../onboarding/core/onboarding-initiation.service";
import { splitName } from "../../../common/hr/split-person-name";

/**
 * Starting onboarding for someone who accepted an offer.
 *
 * `OnboardingInitiationService.initiate` is keyed on a **user id** and refuses
 * anyone without an ACTIVE `organization_members` row (`user_not_found`). A
 * candidate who has just accepted has neither: they are a person and a
 * pre-joining employment, not a login. So this admits them through the same
 * `MembershipAdmissionService` the invite and HR-onboarding paths use — seat
 * lock, plan limit, allowed-email-domain check and all — and then calls
 * `initiate` unchanged.
 *
 * Admission runs AFTER the handoff, not before, and that ordering is safe:
 * `PersonEmploymentSyncService.ensureFromUser` resolves by user id and then by
 * `organization_people.work_email`, so the person the handoff already created
 * under the candidate's email is the one `initiate` finds and links. Admitting
 * first would work too; admitting after keeps the money-touching write (a seat)
 * out of the path that creates the employment record.
 *
 * Nothing here is reported as success unless the service said so. `initiate`
 * returning `already_initiated` IS success — it is what a retry looks like.
 */

export type OnboardingStartOutcome =
  | { started: true; tasksCreated: number; fromTemplate: boolean }
  | { started: true; replay: true }
  | { started: false; reason: string };

@Injectable()
export class RecruitmentOnboardingStartService {
  private readonly logger = new Logger(RecruitmentOnboardingStartService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly admission: MembershipAdmissionService,
    private readonly onboarding: OnboardingInitiationService,
  ) {}

  async startForCandidate(orgId: string, candidateId: number): Promise<OnboardingStartOutcome> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { firstName: true, lastName: true, email: true, phone: true },
    });
    if (!candidate?.email) return { started: false, reason: "candidate-has-no-email" };

    const email = canonicalAdmissionEmail(candidate.email);

    const employment = await this.findPreJoiningEmployment(orgId, email);
    if (!employment)
      return { started: false, reason: "no-employment-record-for-this-candidate" };

    let userId: string;
    try {
      userId = await this.admitCandidate(orgId, email, candidate);
    } catch (error) {
      /**
       * A full plan, a refused email domain or an archived former member all
       * land here. None of them is a reason to claim onboarding started, and
       * none of them should undo the hire — the person and the employment are
       * already committed and a recruiter can finish this by hand.
       */
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`onboarding not started for candidate ${candidateId} in org ${orgId}: ${reason}`);
      return { started: false, reason };
    }

    const result = await this.onboarding.initiate(orgId, userId, { userId });
    if ("error" in result) {
      if (isInitiateAlreadyDone(result)) return { started: true, replay: true };
      return { started: false, reason: result.error };
    }
    return { started: true, tasksCreated: result.tasksCreated, fromTemplate: result.fromTemplate };
  }

  /**
   * The pre-joining employment the handoff created. Its absence means the
   * handoff did not run or did not finish, and starting onboarding then would
   * create a second, unrelated employment through
   * `PersonEmploymentSyncService` — the exact "one person" break this whole
   * path exists to avoid.
   */
  private async findPreJoiningEmployment(orgId: string, workEmail: string) {
    const [row] = await this.db
      .select({ id: hrEmployments.id, lifecycleStatus: hrEmployments.lifecycleStatus })
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, hrEmployments.orgId),
          eq(hrPeople.id, hrEmployments.personId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .innerJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
          isNull(organizationPeople.deletedAt),
        ),
      )
      .where(
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
          eq(organizationPeople.workEmail, workEmail),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async admitCandidate(
    orgId: string,
    email: string,
    candidate: { firstName: string; lastName: string; phone: string | null },
  ): Promise<string> {
    const name = `${candidate.firstName} ${candidate.lastName}`.trim();
    const { firstName, lastName } = splitName(name);

    return withMembershipMutations(this.cache, (membership) =>
      runInTenantTransaction(
        this.db,
        async (tx) => {
          const screen = await this.admission.screen(tx, { orgId, email });
          /**
           * Already a member — an internal hire, or a rehire. That is the
           * outcome we want, not a conflict: use the account that exists.
           */
          if (screen.kind === "conflict" && screen.reason === "already-member") {
            if (screen.userId === undefined)
              throw new Error("already a member but no account could be resolved");
            return screen.userId;
          }
          if (screen.kind !== "clear") throw new Error(screen.kind === "needs-restore" ? `former-member-${screen.status.toLowerCase()}` : screen.reason);

          const [outcome] = await this.admission.admitMany(tx, {
            orgId,
            actor: { userId: "system" },
            membership,
            seatReason: "candidate accepted an offer",
            candidates: [
              {
                email,
                role: ORG_MEMBER_ROLES.MEMBER,
                screen,
                createUserIfMissing: {
                  name,
                  firstName,
                  lastName,
                  phone: candidate.phone ?? undefined,
                  isActive: true,
                },
              },
            ],
          });
          if (!outcome) throw new Error("admission returned no outcome");
          if (outcome.kind !== "admitted")
            throw new Error(outcome.kind === "needs-restore" ? `former-member-${outcome.status.toLowerCase()}` : outcome.message);
          return outcome.userId;
        },
        { orgId },
      ),
    );
  }
}
