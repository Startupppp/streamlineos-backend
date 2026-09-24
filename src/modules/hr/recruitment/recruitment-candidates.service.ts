import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import {
  candidateApplications,
  candidateDocuments,
  candidateDocumentsVault,
  candidateMessages,
  candidateOffers,
  candidateReferenceChecks,
  candidateReferrals,
  candidateSlaTracking,
  candidates,
  interviewBookingLinks,
  interviews,
  organizations,
  vaultAccessLogs,
} from "../../../db/schema";
import { randomUUID } from "node:crypto";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { nextAggregateVersion } from "../../../common/outbox/aggregate-version";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { AccessService } from "../../access/access.service";
import { getCandidateRejectionEmail } from "../../email/templates/recruitment";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { InternalMobilityService } from "./internal-mobility/internal-mobility.service";
import {
  APPLICATION_STATUS_FOR_STAGE,
  STAGE_TRANSITIONS,
  UPDATE_TRANSITIONS,
  type CandidateStage,
} from "./recruitment-candidate-stages";
import {
  decideRejection,
  REJECTION_REASON_LABELS,
  type RejectionReason,
} from "./disposition/rejection-reasons";
import type {
  CandidateListInput,
  CreateCandidateInput,
  StageInput,
  UpdateCandidateInput,
} from "./dto/candidates.schemas";

const CANDIDATE_SEARCH_CAP = 500;

interface RoleNotification {
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

/** What a passing `decideRejection` leaves for the write to carry. */
interface Disposition {
  reason: RejectionReason;
  note: string | null;
}

@Injectable()
export class RecruitmentCandidatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly planLimits: PlanLimitsService,
    private readonly access: AccessService,
    private readonly mobility: InternalMobilityService,
  ) {}

  async list(orgId: string, input: CandidateListInput) {
    const key = `${input.status ?? ""}:${input.source ?? ""}:${input.jobId ?? ""}:${input.search ?? ""}:${input.cursor ?? ""}:${input.limit}`;
    return this.cache.cachedVersioned(
      `hr:candidates:list:${orgId}`,
      key,
      async () => {
        const conditions = [eq(candidates.orgId, orgId)];
        if (input.status) conditions.push(eq(candidates.status, input.status));
        if (input.source) conditions.push(eq(candidates.source, input.source));
        if (input.jobId) {
          conditions.push(
            sql`exists (select 1 from ${candidateApplications} where ${candidateApplications.candidateId} = ${candidates.id} and ${candidateApplications.jobPostingId} = ${input.jobId})`,
          );
        }
        if (input.search) conditions.push(await this.candidateSearchCondition(input.search));

        const position = decodeCursor(input.cursor);
        if (position)
          conditions.push(keysetBeforeId(candidates.createdAt, candidates.id, position));

        const [rows, statusRows] = await Promise.all([
          this.db.query.candidates.findMany({
            where: and(...conditions),
            orderBy: [desc(candidates.createdAt), desc(candidates.id)],
            limit: input.limit + 1,
          }),
          this.db
            .select({ status: candidates.status, total: count() })
            .from(candidates)
            .where(eq(candidates.orgId, orgId))
            .groupBy(candidates.status),
        ]);

        const statusCounts: Record<string, number> = {};
        for (const row of statusRows) {
          if (row.status) statusCounts[row.status] = Number(row.total);
        }

        const page = buildCursorPage(rows, input.limit, (row) => ({
          sortValue: row.createdAt.toISOString(),
          id: String(row.id),
        }));

        return { data: page.data, pagination: page.pagination, statusCounts };
      },
      CACHE_TTL.SHORT,
    );
  }

  async findDuplicates(orgId: string) {
    const rows = await this.db.query.candidates.findMany({
      where: eq(candidates.orgId, orgId),
      columns: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true, createdAt: true, duplicateOfId: true },
      orderBy: [desc(candidates.createdAt), desc(candidates.id)],
      limit: 2000,
    });

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.email?.trim().toLowerCase();
      if (!key) continue;
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }

    return Array.from(groups.values())
      .filter((group) => group.length > 1)
      .map((group) => ({
        key: group[0]!.email,
        candidates: group,
      }));
  }

  private async candidateSearchCondition(search: string): Promise<SQL> {
    const fallback = or(
      ilike(candidates.firstName, `%${search}%`),
      ilike(candidates.lastName, `%${search}%`),
      ilike(candidates.email, `%${search}%`),
      ilike(candidates.currentCompany, `%${search}%`),
    )!;
    const rows = await this.db.execute(
      sql`SELECT app.search_hr_candidate_ids(${search}, ${CANDIDATE_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return sql`false`;
    if (rows.length > CANDIDATE_SEARCH_CAP) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(candidates.id, ids);
  }

  async linkDuplicate(orgId: string, candidateId: number, duplicateOfId: number) {
    if (candidateId === duplicateOfId) {
      throw new UnprocessableEntityException("A candidate cannot be marked as a duplicate of itself.");
    }
    const [existing, target] = await Promise.all([
      this.db.query.candidates.findFirst({ where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)), columns: { id: true, duplicateOfId: true } }),
      this.db.query.candidates.findFirst({ where: and(eq(candidates.id, duplicateOfId), eq(candidates.orgId, orgId)), columns: { id: true, duplicateOfId: true } }),
    ]);
    if (!existing || !target) throw new NotFoundException("Candidate not found.");
    if (target.duplicateOfId === candidateId) {
      throw new UnprocessableEntityException("These two candidates already point at each other.");
    }

    /**
     * Unique on these tables is (org, id), not (candidate, job), so moving
     * `candidateId` cannot collide. Résumés and SLA rows are unique per
     * candidate and stay where they are.
     */
    const moved = [
      candidateApplications,
      candidateMessages,
      candidateDocumentsVault,
      vaultAccessLogs,
      candidateReferrals,
      candidateReferenceChecks,
      interviews,
      candidateOffers,
      interviewBookingLinks,
      candidateDocuments,
    ] as const;

    await this.db.transaction(async (tx) => {
      for (const table of moved) {
        await tx
          .update(table)
          .set({ candidateId: duplicateOfId })
          .where(and(eq(table.orgId, orgId), eq(table.candidateId, candidateId)));
      }
      await tx
        .update(candidates)
        .set({ duplicateOfId, updatedAt: new Date() })
        .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
    });
    await this.cache.invalidateNamespace(`hr:candidates:list:${orgId}`);
    return { success: true };
  }

  async unlinkDuplicate(orgId: string, candidateId: number) {
    const existing = await this.db.query.candidates.findFirst({ where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)), columns: { id: true } });
    if (!existing) throw new NotFoundException("Candidate not found.");

    await this.db.update(candidates).set({ duplicateOfId: null, updatedAt: new Date() }).where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
    await this.cache.invalidateNamespace(`hr:candidates:list:${orgId}`);
    return { success: true };
  }

  async create(orgId: string, input: CreateCandidateInput) {
    await this.planLimits.assertWithinLimit(orgId, "hrCandidates");

    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.orgId, orgId), ilike(candidates.email, input.email.trim())),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException("A candidate with this email already exists in your organization.");
    }

    const [candidate] = await this.db
      .insert(candidates)
      .values({
        orgId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        resumeUrl: input.resumeUrl,
        linkedinUrl: input.linkedinUrl,
        portfolioUrl: input.portfolioUrl,
        currentCompany: input.currentCompany,
        currentRole: input.currentRole,
        experienceYears: input.experienceYears?.toString(),
        skills: input.skills,
        source: input.source || "DIRECT",
        status: "NEW",
        notes: input.notes,
      })
      .returning();

    await this.cache.invalidateNamespace(`hr:candidates:list:${orgId}`);
    return candidate;
  }

  async getDetail(orgId: string, candidateId: number) {
    const [candidate, slaRecords] = await Promise.all([
      this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
        with: {
          applications: {
            columns: { trackingToken: false },
            with: { jobPosting: true },
          },
          interviews: {
            columns: { calendarSyncToken: false },
            with: {
              scorecards: true,
              interviewer: { columns: { id: true, firstName: true, lastName: true, email: true, image: true } },
            },
            orderBy: (t, { desc: d }) => [d(t.scheduledAt)],
          },
        },
      }),
      this.db.query.candidateSlaTracking.findMany({
        where: and(eq(candidateSlaTracking.candidateId, candidateId), eq(candidateSlaTracking.orgId, orgId)),
        orderBy: (t, { asc }) => [asc(t.stage)],
        limit: 100,
      }),
    ]);

    if (!candidate) throw new NotFoundException("Candidate not found.");
    return { ...candidate, slaTracking: slaRecords };
  }

  async update(orgId: string, candidateId: number, input: UpdateCandidateInput) {
    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Candidate not found.");

    if (input.email && input.email !== existing.email) {
      const emailConflict = await this.db.query.candidates.findFirst({
        where: and(
          eq(candidates.orgId, orgId),
          ilike(candidates.email, input.email.trim()),
          ne(candidates.id, candidateId),
        ),
        columns: { id: true },
      });
      if (emailConflict) {
        throw new ConflictException("A candidate with this email already exists in your organization.");
      }
    }

    if (input.status && input.status !== existing.status) {
      const allowed = UPDATE_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(input.status)) {
        throw new UnprocessableEntityException(
          `Cannot move candidate from ${existing.status} to ${input.status}. ${
            existing.status === "REJECTED"
              ? "A rejected candidate must be re-opened to Screening first."
              : existing.status === "HIRED"
                ? "Hired candidates cannot change status."
                : `Allowed next statuses: ${allowed.join(", ") || "none"}.`
          }`,
        );
      }
    }

    /*
      The PATCH endpoint rejects too, and it is the path the candidate detail
      page uses. Gating only `moveStage` would have left the board asking for a
      reason while the profile card beside it still rejected with nothing —
      a required field with a second door is not a required field.

      Only a status that actually changes is gated, matching `moveStage`'s
      no-op return. A PATCH that restates the status a candidate already has
      must not demand a reason, and must not wipe the one already recorded.
    */
    const nextStatus =
      input.status !== undefined && input.status !== existing.status ? input.status : null;
    const disposition = nextStatus === null ? null : this.dispositionFor(nextStatus, input);

    const updateFields: Partial<typeof candidates.$inferInsert> = { updatedAt: new Date() };
    if (input.firstName !== undefined) updateFields.firstName = input.firstName;
    if (input.lastName !== undefined) updateFields.lastName = input.lastName;
    if (input.email !== undefined) updateFields.email = input.email;
    if (input.phone !== undefined) updateFields.phone = input.phone;
    if (input.linkedinUrl !== undefined) updateFields.linkedinUrl = input.linkedinUrl || null;
    if (input.portfolioUrl !== undefined) updateFields.portfolioUrl = input.portfolioUrl || null;
    if (input.currentCompany !== undefined) updateFields.currentCompany = input.currentCompany;
    if (input.currentRole !== undefined) updateFields.currentRole = input.currentRole;
    if (input.experienceYears !== undefined) updateFields.experienceYears = String(input.experienceYears);
    if (input.skills !== undefined) updateFields.skills = input.skills;
    if (input.source !== undefined) updateFields.source = input.source;
    if (input.status !== undefined) updateFields.status = input.status;
    if (nextStatus !== null) {
      /* Same clearing rule as `moveStage`: a reason describes the current
         disposition, so a status change that is not a reject removes it. */
      updateFields.rejectionReason = disposition?.reason ?? null;
      updateFields.rejectionNote = disposition?.note ?? null;
    }
    if (input.notes !== undefined) updateFields.notes = input.notes;
    if (input.rating !== undefined) updateFields.rating = input.rating;
    if (input.resumeUrl !== undefined) updateFields.resumeUrl = input.resumeUrl || null;

    await this.db.update(candidates).set(updateFields).where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    if (input.status === "REJECTED" && existing.status !== "REJECTED") {
      await this.notifyPermissionHolders(orgId, "hr:interviews:manage", {
        type: "INFO",
        title: "Candidate Rejected",
        message: `${existing.firstName} ${existing.lastName} has been moved to Rejected${
          disposition ? ` — ${REJECTION_REASON_LABELS[disposition.reason]}` : ""
        }.`,
        link: `/hr/recruitment/candidates/${candidateId}`,
        metadata: {
          candidateId,
          stage: "REJECTED",
          rejectionReason: disposition?.reason ?? null,
        },
      });

      const emailTarget = input.email ?? existing.email;
      if (emailTarget) {
        void this.dispatchRejectionEmail(
          orgId,
          candidateId,
          `${existing.firstName} ${existing.lastName}`,
          emailTarget,
        ).catch(() => undefined);
      }
    }

    return { success: true };
  }

  /*
    `remove` is gone. It hard-deleted the candidate, their applications,
    interviews and SLA rows while never touching `candidate_documents_vault`,
    which left the résumé in the bucket with nothing pointing at it — and
    returned `{ success: true }`. Deleting a candidate now goes through
    `CandidateErasureService.eraseCandidate`, which ledgers every object before
    attempting its delete and reports whether the store confirmed it. Do not
    reintroduce a delete here: a second one would not be covered by that
    service's spec, which is the only place the ordering is pinned.
  */

  async moveStage(orgId: string, userId: string, candidateId: number, input: StageInput) {
    const newStage = input.stage;
    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Candidate not found.");

    if (existing.status === newStage) {
      return { id: candidateId, stage: newStage, changed: false };
    }

    const currentStage = existing.status;
    const allowed = STAGE_TRANSITIONS[currentStage] ?? [];
    if (!allowed.includes(newStage)) {
      throw new UnprocessableEntityException(
        `Cannot move candidate from ${currentStage} to ${newStage}. ${
          currentStage === "REJECTED"
            ? "Rejected candidates must be re-opened to Screening first."
            : `Valid transitions from ${currentStage}: ${allowed.join(", ") || "none"}.`
        }`,
      );
    }

    /*
      Decided before anything is written, and it throws rather than defaulting.
      A reject that moved the stage first and only then discovered it had no
      reason would leave a candidate marked REJECTED with an empty disposition,
      and nothing downstream could tell that row apart from one recorded before
      this rule existed.
    */
    const disposition = this.dispositionFor(newStage, input);

    const [updated] = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(candidates)
        .set({
          status: newStage,
          /*
            Cleared on every move that is not a reject, which includes the
            re-open edge REJECTED → SCREENING. A reason left behind on somebody
            who is back in the pipeline renders on their detail page as a live
            rejection, and a report counting rejection reasons would count a
            candidate still being interviewed.
          */
          rejectionReason: disposition?.reason ?? null,
          rejectionNote: disposition?.note ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)))
        .returning();

      await tx
        .insert(candidateSlaTracking)
        .values({
          orgId,
          candidateId,
          stage: newStage,
          enteredAt: new Date(),
          breachedAt: null,
          status: "ON_TRACK",
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [candidateSlaTracking.candidateId, candidateSlaTracking.stage],
          set: { enteredAt: new Date(), breachedAt: null, status: "ON_TRACK", updatedAt: new Date() },
        });

      /**
       * The application follows the card. These were two unrelated stories:
       * the recruiter moved the candidate to Interview and the candidate's own
       * `/application-status/:token` page still said "Applied", for the whole
       * pipeline. Same transaction, so they cannot disagree again.
       */
      const latestApplication = await tx.query.candidateApplications.findFirst({
        where: and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.candidateId, candidateId),
        ),
        columns: { id: true, jobPostingId: true },
        orderBy: (t, { desc: d }) => [d(t.appliedAt)],
      });
      const applicationStatus = APPLICATION_STATUS_FOR_STAGE[newStage];
      if (latestApplication && applicationStatus)
        await tx
          .update(candidateApplications)
          .set({ status: applicationStatus, updatedAt: new Date() })
          .where(
            and(
              eq(candidateApplications.id, latestApplication.id),
              eq(candidateApplications.orgId, orgId),
            ),
          );

      /**
       * The webhook consumer and the delivery cron were built for these names
       * and nothing emitted them, so a tenant could subscribe to
       * `candidate.moved` and never receive one. `candidate.hired` is the same
       * event an offer acceptance emits — consumers dedupe on event id, which
       * is why both may legitimately fire for one hire.
       */
      const aggregate = {
        organizationId: orgId,
        aggregateType: "candidate",
        aggregateId: String(candidateId),
      };
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        ...aggregate,
        aggregateVersion: await nextAggregateVersion(tx, aggregate),
        eventType:
          newStage === "REJECTED"
            ? "candidate.rejected"
            : newStage === "HIRED"
              ? "candidate.hired"
              : "candidate.moved",
        payload: {
          candidateId,
          jobPostingId: latestApplication?.jobPostingId ?? null,
          fromStage: currentStage,
          toStage: newStage,
          /*
            `recruitment-webhook-events.ts` has documented a `reason` on
            `candidate.rejected` since the event existed, and nothing ever sent
            one — a subscriber reading the sample payload built a field that
            arrived undefined on every delivery. The code travels, not the
            label: a subscriber keying on prose would break the next time the
            wording changed.
          */
          reason: disposition?.reason ?? null,
          reasonNote: disposition?.note ?? null,
        },
        occurredAt: new Date(),
      });

      return [row];
    });

    this.audit.log({
      action: "CANDIDATE_STAGE_CHANGED",
      userId,
      orgId,
      targetId: String(candidateId),
      targetType: "candidate",
      metadata: {
        from: existing.status,
        to: newStage,
        candidateName: `${existing.firstName} ${existing.lastName}`,
        rejectionReason: disposition?.reason ?? null,
      },
    });

    if (newStage === "REJECTED") {
      await this.notifyPermissionHolders(orgId, "hr:interviews:manage", {
        type: "INFO",
        title: "Candidate Rejected",
        /*
          The label is rendered here and the code is what the metadata carries.
          A notification is read once by a person; the metadata is what a
          later query groups by, and a reworded label must not split it.
        */
        message: `${existing.firstName} ${existing.lastName} has been moved to Rejected${
          disposition ? ` — ${REJECTION_REASON_LABELS[disposition.reason]}` : ""
        }.`,
        link: `/hr/recruitment/candidates/${candidateId}`,
        metadata: { candidateId, stage: newStage, rejectionReason: disposition?.reason ?? null },
      });

      if (existing.email) {
        void this.dispatchRejectionEmail(
          orgId,
          candidateId,
          `${existing.firstName} ${existing.lastName}`,
          existing.email,
        ).catch(() => undefined);
      }
    }

    /*
      The applicant's own manager, told at interview and not before.

      Deferred rather than awaited inside the transaction: the notice is a
      write to another aggregate plus a lookup, and holding the pooled
      connection for it would make a slow notifications table a slow board. The
      service never throws, so a failure here is logged and the stage move —
      which the recruiter already made — stands.
    */
    const movedToStatus = APPLICATION_STATUS_FOR_STAGE[newStage];
    if (movedToStatus) {
      const notify = () => this.mobility.notifyManagerIfVisible(orgId, candidateId, movedToStatus);
      if (!registerAfterCommit(notify)) await notify();
    }

    void this.automation
      .runAutomationsForEvent(orgId, "candidate.stage_changed", {
        candidateId,
        candidateName: `${existing.firstName} ${existing.lastName}`,
        candidateEmail: existing.email ?? "",
        previousStatus: existing.status,
        newStatus: newStage,
      })
      .catch(() => undefined);

    return { id: updated.id, stage: updated.status, changed: true };
  }

  /**
   * The disposition a move to `stage` must carry, or null when the stage is not
   * a rejection.
   *
   * One helper for both write paths rather than the check inlined twice. Two
   * copies drift, and the copy that drifts is the one nobody wrote a test for —
   * which is how the PATCH endpoint would end up as the quiet way to reject
   * somebody without saying why.
   */
  private dispositionFor(
    stage: CandidateStage,
    input: { rejectionReason?: string; rejectionNote?: string },
  ): Disposition | null {
    if (stage !== "REJECTED") return null;
    const decision = decideRejection({
      reason: input.rejectionReason,
      note: input.rejectionNote,
    });
    if (!decision.allowed) throw new UnprocessableEntityException(decision.message);
    return { reason: decision.reason, note: decision.note };
  }

  private async dispatchRejectionEmail(
    orgId: string,
    candidateId: number,
    candidateName: string,
    email: string,
  ): Promise<void> {
    const [latestApp, org] = await Promise.all([
      this.db.query.candidateApplications.findFirst({
        where: eq(candidateApplications.candidateId, candidateId),
        with: { jobPosting: { columns: { title: true } } },
        orderBy: (t, { desc: d }) => [d(t.appliedAt)],
      }),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      }),
    ]);

    const { subject, html } = getCandidateRejectionEmail({
      candidateName,
      jobTitle: latestApp?.jobPosting?.title ?? "the position",
      companyName: org?.name ?? "our company",
    });

    await this.email.sendEmail({ to: email, subject, html });
  }

  private async notifyPermissionHolders(
    orgId: string,
    permissionKey: string,
    opts: RoleNotification,
  ) {
    const targets = await this.access.membersWithPermission(orgId, permissionKey);
    await Promise.all(
      targets.map((m) =>
        this.notifications.create({
          orgId,
          userId: m.userId,
          type: opts.type,
          title: opts.title,
          message: opts.message,
          link: opts.link,
          metadata: opts.metadata,
        }),
      ),
    );
  }
}
