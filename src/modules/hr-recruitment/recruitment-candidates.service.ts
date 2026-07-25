import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, count, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { buildListResponse } from "../../common/pagination/pagination";
import {
  candidateApplications,
  candidateSlaTracking,
  candidates,
  interviews,
  organizationMembers,
  organizations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import { getCandidateRejectionEmail } from "../email/templates/recruitment";
import type {
  CandidateListInput,
  CreateCandidateInput,
  StageInput,
  UpdateCandidateInput,
} from "./dto/candidates.schemas";

type CandidateStage = "NEW" | "SCREENING" | "INTERVIEW" | "OFFER" | "HIRED" | "REJECTED";

const UPDATE_TRANSITIONS: Record<string, CandidateStage[]> = {
  NEW: ["SCREENING", "REJECTED"],
  SCREENING: ["NEW", "INTERVIEW", "REJECTED"],
  INTERVIEW: ["SCREENING", "OFFER", "REJECTED"],
  OFFER: ["INTERVIEW", "HIRED", "REJECTED"],
  HIRED: [],
  REJECTED: ["SCREENING"],
};

const STAGE_TRANSITIONS: Record<CandidateStage, CandidateStage[]> = {
  NEW: ["SCREENING", "REJECTED"],
  SCREENING: ["INTERVIEW", "REJECTED"],
  INTERVIEW: ["OFFER", "REJECTED"],
  OFFER: ["HIRED", "REJECTED"],
  HIRED: [],
  REJECTED: ["SCREENING"],
};

interface RoleNotification {
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
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
  ) {}

  async list(orgId: string, input: CandidateListInput) {
    const key = `hr:candidates:list:${orgId}:${input.status ?? ""}:${input.source ?? ""}:${input.jobId ?? ""}:${input.search ?? ""}:${input.page}:${input.pageSize}`;
    return this.cache.cached(
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
        if (input.search) {
          const q = `%${input.search}%`;
          const searchFilter = or(
            ilike(candidates.firstName, q),
            ilike(candidates.lastName, q),
            ilike(candidates.email, q),
            ilike(candidates.currentCompany, q),
          );
          if (searchFilter) conditions.push(searchFilter);
        }

        const where = and(...conditions);

        const [items, totalRow, statusRows] = await Promise.all([
          this.db.query.candidates.findMany({
            where,
            orderBy: [desc(candidates.createdAt)],
            limit: input.limit,
            offset: input.offset,
          }),
          this.db
            .select({ total: count() })
            .from(candidates)
            .where(where)
            .then((rows) => rows[0] ?? { total: 0 }),
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

        return {
          ...buildListResponse(items, Number(totalRow.total), {
            page: input.page,
            pageSize: input.pageSize,
          }),
          statusCounts,
        };
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

  async linkDuplicate(orgId: string, candidateId: number, duplicateOfId: number) {
    if (candidateId === duplicateOfId) {
      throw new UnprocessableEntityException("A candidate cannot be marked as a duplicate of itself.");
    }
    const [existing, target] = await Promise.all([
      this.db.query.candidates.findFirst({ where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)), columns: { id: true } }),
      this.db.query.candidates.findFirst({ where: and(eq(candidates.id, duplicateOfId), eq(candidates.orgId, orgId)), columns: { id: true } }),
    ]);
    if (!existing || !target) throw new NotFoundException("Candidate not found.");

    await this.db.update(candidates).set({ duplicateOfId, updatedAt: new Date() }).where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
    await this.cache.invalidatePattern(`hr:candidates:list:${orgId}:*`);
    return { success: true };
  }

  async unlinkDuplicate(orgId: string, candidateId: number) {
    const existing = await this.db.query.candidates.findFirst({ where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)), columns: { id: true } });
    if (!existing) throw new NotFoundException("Candidate not found.");

    await this.db.update(candidates).set({ duplicateOfId: null, updatedAt: new Date() }).where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
    await this.cache.invalidatePattern(`hr:candidates:list:${orgId}:*`);
    return { success: true };
  }

  async create(orgId: string, input: CreateCandidateInput) {
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

    await this.cache.invalidatePattern(`hr:candidates:list:${orgId}:*`);
    return candidate;
  }

  async getDetail(orgId: string, candidateId: number) {
    const [candidate, slaRecords] = await Promise.all([
      this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
        with: {
          applications: { with: { jobPosting: true } },
          interviews: {
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
    if (input.notes !== undefined) updateFields.notes = input.notes;
    if (input.rating !== undefined) updateFields.rating = input.rating;
    if (input.resumeUrl !== undefined) updateFields.resumeUrl = input.resumeUrl || null;

    await this.db.update(candidates).set(updateFields).where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    if (input.status === "REJECTED" && existing.status !== "REJECTED") {
      await this.notifyByRoles(orgId, ["HR_MANAGER", "CEO", "HR"], {
        type: "INFO",
        title: "Candidate Rejected",
        message: `${existing.firstName} ${existing.lastName} has been moved to Rejected.`,
        link: `/hr/recruitment/candidates/${candidateId}`,
        metadata: { candidateId, stage: "REJECTED" },
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

  async remove(orgId: string, candidateId: number) {
    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Candidate not found.");

    await this.db.transaction(async (tx) => {
      await tx.delete(candidateSlaTracking).where(and(eq(candidateSlaTracking.candidateId, candidateId), eq(candidateSlaTracking.orgId, orgId)));
      await tx.delete(interviews).where(and(eq(interviews.candidateId, candidateId), eq(interviews.orgId, orgId)));
      await tx.delete(candidateApplications).where(and(eq(candidateApplications.candidateId, candidateId), eq(candidateApplications.orgId, orgId)));
      await tx.delete(candidates).where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
    });

    return { success: true };
  }

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

    const [updated] = await this.db
      .update(candidates)
      .set({ status: newStage, updatedAt: new Date() })
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)))
      .returning();

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
      },
    });

    if (newStage === "REJECTED") {
      await this.notifyByRoles(orgId, ["HR_MANAGER", "CEO", "HR"], {
        type: "INFO",
        title: "Candidate Rejected",
        message: `${existing.firstName} ${existing.lastName} has been moved to Rejected.`,
        link: `/hr/recruitment/candidates/${candidateId}`,
        metadata: { candidateId, stage: newStage },
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

    await this.db
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

  private async notifyByRoles(orgId: string, roles: string[], opts: RoleNotification) {
    const members = await this.db
      .select({ userId: organizationMembers.userId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    const targets = members.filter((m) => roles.includes(m.role));
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
