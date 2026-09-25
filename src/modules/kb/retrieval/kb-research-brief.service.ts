import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { kbResearchBriefs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AiJobsService } from "../../ai/jobs/ai-jobs.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  KbCitationVisibilityService,
  type CitedRef,
} from "./kb-citation-visibility.service";
import type { KbResearchBriefCreateInput, KbResearchBriefListInput } from "./dto/kb-ai.schemas";

export const KB_RESEARCH_BRIEF_CONCURRENT_LIMIT = 10;

function toCitedRef(citation: { kind: string; id: number }): CitedRef | null {
  if (citation.kind === "article" || citation.kind === "page" || citation.kind === "source")
    return { kind: citation.kind, id: citation.id };
  return null;
}

type BriefSummary = {
  id: number;
  orgId: string;
  userId: string | null;
  topic: string;
  spaceId: number | null;
  status: string;
  jobId: number | null;
  sourceCount: number;
  errorMessage: string | null;
  rating: "helpful" | "not_helpful" | null;
  costCredits: number | null;
  provider: string | null;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type BriefDetail = BriefSummary & { report: string | null; citations: Array<{ kind: string; id: number; title: string; href: string | null; updatedAt: string | null }> | null };

@Injectable()
export class KbResearchBriefService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiJobs: AiJobsService,
    private readonly citationVisibility: KbCitationVisibilityService,
  ) {}

  async enqueue(user: CurrentUserContext, input: KbResearchBriefCreateInput): Promise<{ briefId: number; jobId: number }> {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required");

    const [activeRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(kbResearchBriefs)
      .where(and(eq(kbResearchBriefs.orgId, user.orgId), inArray(kbResearchBriefs.status, ["queued", "running"])));
    if ((activeRow?.count ?? 0) >= KB_RESEARCH_BRIEF_CONCURRENT_LIMIT) {
      throw new HttpException(
        { message: `Research job quota exceeded (limit: ${KB_RESEARCH_BRIEF_CONCURRENT_LIMIT} concurrent)`, code: "KB_RESEARCH_JOB_QUOTA_EXCEEDED" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const inserted = await this.db
      .insert(kbResearchBriefs)
      .values({
        orgId: user.orgId,
        userMembershipId: membershipId,
        topic: input.topic,
        spaceId: input.spaceId ?? null,
        status: "queued",
      })
      .returning({ id: kbResearchBriefs.id });

    const briefId = inserted[0]?.id;
    if (!briefId) throw new Error("Failed to create research brief");

    const { jobId } = await this.aiJobs.enqueue({
      orgId: user.orgId,
      userId: user.userId,
      type: "kb.research-brief",
      payload: { briefId, topic: input.topic, spaceId: input.spaceId ?? null },
      idempotencyKey: `kb-brief-${user.orgId}-${briefId}`,
    });

    await this.db
      .update(kbResearchBriefs)
      .set({ jobId })
      .where(eq(kbResearchBriefs.id, briefId));

    return { briefId, jobId };
  }

  async list(
    user: CurrentUserContext,
    opts: KbResearchBriefListInput,
  ): Promise<{ items: BriefSummary[]; nextCursor: number | null }> {
    const limit = Math.min(opts.limit, 100);
    const membershipId = actingMembershipId(user.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const conditions = [
      eq(kbResearchBriefs.orgId, user.orgId),
      eq(kbResearchBriefs.userMembershipId, membershipId),
    ];
    if (opts.cursor) conditions.push(lt(kbResearchBriefs.id, opts.cursor));

    const rows = await this.db
      .select({
        id: kbResearchBriefs.id,
        orgId: kbResearchBriefs.orgId,
        userId: sql<string>`${user.userId}`,
        topic: kbResearchBriefs.topic,
        spaceId: kbResearchBriefs.spaceId,
        status: kbResearchBriefs.status,
        jobId: kbResearchBriefs.jobId,
        sourceCount: kbResearchBriefs.sourceCount,
        errorMessage: kbResearchBriefs.errorMessage,
        rating: kbResearchBriefs.rating,
        costCredits: kbResearchBriefs.costCredits,
        provider: kbResearchBriefs.provider,
        model: kbResearchBriefs.model,
        createdAt: kbResearchBriefs.createdAt,
        updatedAt: kbResearchBriefs.updatedAt,
      })
      .from(kbResearchBriefs)
      .where(and(...conditions))
      .orderBy(desc(kbResearchBriefs.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return { items: page, nextCursor };
  }

  async getById(user: CurrentUserContext, briefId: number): Promise<BriefDetail> {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const rows = await this.db
      .select({
        id: kbResearchBriefs.id,
        orgId: kbResearchBriefs.orgId,
        userId: sql<string>`${user.userId}`,
        topic: kbResearchBriefs.topic,
        spaceId: kbResearchBriefs.spaceId,
        status: kbResearchBriefs.status,
        jobId: kbResearchBriefs.jobId,
        sourceCount: kbResearchBriefs.sourceCount,
        report: kbResearchBriefs.report,
        citations: kbResearchBriefs.citations,
        errorMessage: kbResearchBriefs.errorMessage,
        rating: kbResearchBriefs.rating,
        costCredits: kbResearchBriefs.costCredits,
        provider: kbResearchBriefs.provider,
        model: kbResearchBriefs.model,
        createdAt: kbResearchBriefs.createdAt,
        updatedAt: kbResearchBriefs.updatedAt,
      })
      .from(kbResearchBriefs)
      .where(
        and(
          eq(kbResearchBriefs.id, briefId),
          eq(kbResearchBriefs.orgId, user.orgId),
          eq(kbResearchBriefs.userMembershipId, membershipId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("Research brief not found");
    await this.assertCitationsStillVisible(user, row.citations);
    return row;
  }

  /**
   * A brief is written once and re-opened for months, so its stored citations are a snapshot of
   * who could read what at generation time. Dropping the newly-invisible ones from the list would
   * still serve a report whose prose was written FROM those documents, so the whole brief is
   * refused instead — the same rule `KbAskService.assertReplayCitations` applies to a saved answer.
   */
  private async assertCitationsStillVisible(
    user: CurrentUserContext,
    citations: BriefDetail["citations"],
  ): Promise<void> {
    if (citations === null || citations.length === 0) return;
    const refs = citations.flatMap((citation) => {
      const ref = toCitedRef(citation);
      return ref ? [ref] : [];
    });
    if (refs.length === 0) return;
    const { visible } = await this.citationVisibility.partitionVisible(user, refs);
    if (refs.some((ref) => !visible(ref)))
      throw new NotFoundException("This research brief is no longer accessible");
  }

  async retryBrief(user: CurrentUserContext, briefId: number): Promise<{ briefId: number; jobId: number }> {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const rows = await this.db
      .select({ id: kbResearchBriefs.id, status: kbResearchBriefs.status, topic: kbResearchBriefs.topic, spaceId: kbResearchBriefs.spaceId })
      .from(kbResearchBriefs)
      .where(
        and(
          eq(kbResearchBriefs.id, briefId),
          eq(kbResearchBriefs.orgId, user.orgId),
          eq(kbResearchBriefs.userMembershipId, membershipId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("Research brief not found");
    if (row.status !== "failed") throw new BadRequestException("Only failed briefs can be retried");

    const { jobId } = await this.aiJobs.enqueue({
      orgId: user.orgId,
      userId: user.userId,
      type: "kb.research-brief",
      payload: { briefId, topic: row.topic, spaceId: row.spaceId ?? null },
      idempotencyKey: `kb-brief-retry-${user.orgId}-${briefId}-${Date.now()}`,
    });

    await this.db
      .update(kbResearchBriefs)
      .set({ status: "queued", jobId, errorMessage: null, report: null, citations: null, sourceCount: 0 })
      .where(eq(kbResearchBriefs.id, briefId));

    return { briefId, jobId };
  }

  async cancelBrief(user: CurrentUserContext, briefId: number): Promise<void> {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const rows = await this.db
      .select({ id: kbResearchBriefs.id, status: kbResearchBriefs.status, jobId: kbResearchBriefs.jobId })
      .from(kbResearchBriefs)
      .where(
        and(
          eq(kbResearchBriefs.id, briefId),
          eq(kbResearchBriefs.orgId, user.orgId),
          eq(kbResearchBriefs.userMembershipId, membershipId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("Research brief not found");
    if (row.status !== "queued") throw new BadRequestException("Only queued briefs can be cancelled");
    if (row.jobId != null) await this.aiJobs.cancel(user.orgId, row.jobId);
    await this.db
      .update(kbResearchBriefs)
      .set({ status: "failed", errorMessage: "Cancelled" })
      .where(eq(kbResearchBriefs.id, briefId));
  }

  async rateBrief(user: CurrentUserContext, briefId: number, rating: "helpful" | "not_helpful"): Promise<void> {
    const membershipId = actingMembershipId(user.principal);
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const existing = await this.db
      .select({ id: kbResearchBriefs.id })
      .from(kbResearchBriefs)
      .where(
        and(
          eq(kbResearchBriefs.id, briefId),
          eq(kbResearchBriefs.orgId, user.orgId),
          eq(kbResearchBriefs.userMembershipId, membershipId),
        ),
      )
      .limit(1);
    if (existing.length === 0) throw new NotFoundException("Research brief not found");
    await this.db
      .update(kbResearchBriefs)
      .set({ rating })
      .where(eq(kbResearchBriefs.id, briefId));
  }
}
