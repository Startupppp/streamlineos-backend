import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  candidateSources,
  candidates,
  jobPostings,
  jobRecruiters,
  recruiterActivityLog,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { RecruiterActivityInput, RecruiterActivityQueryInput, UpsertPortalInput } from "./dto/jobs.schemas";
import { SUPPORTED_BOARDS, isSupportedBoard, resolveBoard } from "./boards/job-board-adapters";
import { ProviderCredentialsService } from "./integrations/provider-credentials.service";

const RECRUITER_DIRECTORY_LIMIT = 500;
const PORTAL_LIMIT = 100;

@Injectable()
export class RecruitmentRecruitersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly credentials: ProviderCredentialsService,
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
      .orderBy(candidateSources.platform)
      .limit(PORTAL_LIMIT);
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

  /**
   * Pull new applications from a source portal.
   *
   * It stamped `lastSyncedAt` and returned `SYNC_INITIATED` with "New
   * applications will appear in the ATS pipeline shortly", having contacted
   * nobody — a recruiter who read that and waited would wait forever. With no
   * adapter registered the answer is `BLOCKED` and a code, and `lastSyncedAt`
   * is NOT stamped, because nothing synced.
   */
  async syncPortal(orgId: string, rawPlatform: string) {
    const platform = rawPlatform.toUpperCase();
    if (!isSupportedBoard(platform)) {
      throw new BadRequestException(
        `Unsupported platform: ${rawPlatform}. Supported: ${SUPPORTED_BOARDS.join(", ")}`,
      );
    }

    const source = await this.db.query.candidateSources.findFirst({
      where: and(eq(candidateSources.orgId, orgId), eq(candidateSources.platform, platform)),
    });

    const credentials = await this.credentials.forPlatform(orgId, platform);
    const resolved = resolveBoard(platform, credentials);
    if (!("adapter" in resolved))
      return { ...resolved, lastSyncedAt: source?.lastSyncedAt ?? null };

    const result = await resolved.adapter.sync(resolved.credentials);
    const now = new Date();
    await this.db
      .update(candidateSources)
      .set({ lastSyncedAt: now, lastSyncCount: result.fetched, updatedAt: now })
      .where(eq(candidateSources.id, source?.id ?? -1));

    return {
      platform,
      status: "SYNCED" as const,
      fetched: result.fetched,
      lastSyncedAt: now.toISOString(),
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
      .where(inArray(users.id, recruiterIds))
      .limit(RECRUITER_DIRECTORY_LIMIT);

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
