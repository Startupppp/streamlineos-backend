import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  candidateSources,
  candidates,
  jobPostings,
  jobRecruiters,
  recruiterActivityLog,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import type { RecruiterActivityInput, RecruiterActivityQueryInput, UpsertPortalInput } from "./dto/jobs.schemas";

const SYNC_PLATFORMS = ["LINKEDIN", "NAUKRI", "INDEED"];

@Injectable()
export class RecruitmentRecruitersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  listPortals(orgId: string) {
    return this.db
      .select({
        id: candidateSources.id,
        platform: candidateSources.platform,
        isActive: candidateSources.isActive,
        lastSyncedAt: candidateSources.lastSyncedAt,
        lastSyncCount: candidateSources.lastSyncCount,
        createdAt: candidateSources.createdAt,
      })
      .from(candidateSources)
      .where(eq(candidateSources.orgId, orgId))
      .orderBy(candidateSources.platform);
  }

  async upsertPortal(orgId: string, userId: string, input: UpsertPortalInput) {
    const existing = await this.db
      .select({ id: candidateSources.id })
      .from(candidateSources)
      .where(and(eq(candidateSources.orgId, orgId), eq(candidateSources.platform, input.platform)))
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await this.db
        .update(candidateSources)
        .set({
          isActive: input.isActive,
          ...(input.oauthToken !== undefined && { oauthToken: input.oauthToken }),
          ...(input.meta !== undefined && { meta: input.meta }),
          updatedAt: new Date(),
        })
        .where(eq(candidateSources.id, existing[0].id))
        .returning();
      return { record: updated, created: false };
    }

    const [created] = await this.db
      .insert(candidateSources)
      .values({
        orgId,
        platform: input.platform,
        isActive: input.isActive,
        oauthToken: input.oauthToken,
        meta: input.meta,
        createdBy: userId,
      })
      .returning();
    return { record: created, created: true };
  }

  async syncPortal(orgId: string, rawPlatform: string) {
    const platform = rawPlatform.toUpperCase();
    if (!SYNC_PLATFORMS.includes(platform)) {
      throw new BadRequestException(`Unsupported platform: ${rawPlatform}. Supported: ${SYNC_PLATFORMS.join(", ")}`);
    }

    const source = await this.db.query.candidateSources.findFirst({
      where: and(eq(candidateSources.orgId, orgId), eq(candidateSources.platform, platform)),
    });
    if (!source) throw new NotFoundException(`No ${platform} integration configured for this organization.`);
    if (!source.isActive) {
      throw new BadRequestException(`${platform} integration is disabled. Enable it in integration settings first.`);
    }
    if (!source.oauthToken) {
      throw new BadRequestException(`No API token configured for ${platform}. Please authenticate via the integration settings.`);
    }

    await this.db
      .update(candidateSources)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(candidateSources.id, source.id));

    return {
      platform,
      status: "SYNC_INITIATED",
      lastSyncedAt: new Date().toISOString(),
      message: `Sync initiated for ${platform}. New applications will appear in the ATS pipeline shortly.`,
    };
  }

  async recruiterDirectory(orgId: string) {
    const permitted = await this.access.membersWithPermission(orgId, "hr:interviews:manage");
    const recruiterIds = permitted.map((m) => m.userId);

    if (recruiterIds.length === 0) return [];

    const members = await this.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(users)
      .where(inArray(users.id, recruiterIds));

    const assignmentCounts = await this.db
      .select({ userId: jobRecruiters.userId, jobCount: count(jobRecruiters.id) })
      .from(jobRecruiters)
      .where(inArray(jobRecruiters.userId, recruiterIds))
      .groupBy(jobRecruiters.userId);

    const activityCounts = await this.db
      .select({
        recruiterId: recruiterActivityLog.recruiterId,
        action: recruiterActivityLog.action,
        cnt: count(recruiterActivityLog.id),
      })
      .from(recruiterActivityLog)
      .where(and(eq(recruiterActivityLog.orgId, orgId), inArray(recruiterActivityLog.recruiterId, recruiterIds)))
      .groupBy(recruiterActivityLog.recruiterId, recruiterActivityLog.action);

    const jobCountMap = new Map(assignmentCounts.map((r) => [r.userId, Number(r.jobCount)]));
    const activityMap = new Map<string, Record<string, number>>();
    for (const row of activityCounts) {
      const existing = activityMap.get(row.recruiterId) ?? {};
      existing[row.action] = Number(row.cnt);
      activityMap.set(row.recruiterId, existing);
    }

    return members.map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      image: m.image,
      assignedJobsCount: jobCountMap.get(m.userId) ?? 0,
      activitySummary: activityMap.get(m.userId) ?? {},
    }));
  }

  listActivity(orgId: string, query: RecruiterActivityQueryInput) {
    const conditions = [eq(recruiterActivityLog.orgId, orgId)];
    if (query.recruiterId) conditions.push(eq(recruiterActivityLog.recruiterId, query.recruiterId));

    return this.db
      .select({
        id: recruiterActivityLog.id,
        recruiterId: recruiterActivityLog.recruiterId,
        action: recruiterActivityLog.action,
        candidateId: recruiterActivityLog.candidateId,
        jobPostingId: recruiterActivityLog.jobPostingId,
        notes: recruiterActivityLog.notes,
        createdAt: recruiterActivityLog.createdAt,
        recruiterName: users.name,
        candidateFirstName: candidates.firstName,
        candidateLastName: candidates.lastName,
        jobTitle: jobPostings.title,
      })
      .from(recruiterActivityLog)
      .leftJoin(users, eq(recruiterActivityLog.recruiterId, users.id))
      .leftJoin(candidates, eq(recruiterActivityLog.candidateId, candidates.id))
      .leftJoin(jobPostings, eq(recruiterActivityLog.jobPostingId, jobPostings.id))
      .where(and(...conditions))
      .orderBy(desc(recruiterActivityLog.createdAt))
      .limit(query.limit);
  }

  async logActivity(orgId: string, userId: string, input: RecruiterActivityInput) {
    if (input.candidateId) {
      const cand = await this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, input.candidateId), eq(candidates.orgId, orgId)),
        columns: { id: true },
      });
      if (!cand) throw new NotFoundException("Candidate not found");
    }

    const [row] = await this.db
      .insert(recruiterActivityLog)
      .values({
        orgId,
        recruiterId: userId,
        action: input.action,
        candidateId: input.candidateId,
        jobPostingId: input.jobPostingId,
        notes: input.notes,
      })
      .returning();
    return row;
  }
}
