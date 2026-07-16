import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { kbResearchBriefs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AiJobsService } from "../ai-jobs/ai-jobs.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { KbResearchBriefCreateInput, KbResearchBriefListInput } from "./dto/kb-ai.schemas";

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
  createdAt: Date;
  updatedAt: Date;
};

type BriefDetail = BriefSummary & { report: string | null; citations: Array<{ kind: string; id: number; title: string; href: string | null; updatedAt: string | null }> | null };

@Injectable()
export class KbResearchBriefService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiJobs: AiJobsService,
  ) {}

  async enqueue(user: CurrentUserContext, input: KbResearchBriefCreateInput): Promise<{ briefId: number; jobId: number }> {
    const inserted = await this.db
      .insert(kbResearchBriefs)
      .values({
        orgId: user.orgId,
        userId: user.userId,
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
    const conditions = [
      eq(kbResearchBriefs.orgId, user.orgId),
      eq(kbResearchBriefs.userId, user.userId),
    ];
    if (opts.cursor) conditions.push(lt(kbResearchBriefs.id, opts.cursor));

    const rows = await this.db
      .select({
        id: kbResearchBriefs.id,
        orgId: kbResearchBriefs.orgId,
        userId: kbResearchBriefs.userId,
        topic: kbResearchBriefs.topic,
        spaceId: kbResearchBriefs.spaceId,
        status: kbResearchBriefs.status,
        jobId: kbResearchBriefs.jobId,
        sourceCount: kbResearchBriefs.sourceCount,
        errorMessage: kbResearchBriefs.errorMessage,
        rating: kbResearchBriefs.rating,
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
    const row = await this.db.query.kbResearchBriefs.findFirst({
      where: and(
        eq(kbResearchBriefs.id, briefId),
        eq(kbResearchBriefs.orgId, user.orgId),
        eq(kbResearchBriefs.userId, user.userId),
      ),
    });
    if (!row) throw new NotFoundException("Research brief not found");
    return row;
  }

  async rateBrief(user: CurrentUserContext, briefId: number, rating: "helpful" | "not_helpful"): Promise<void> {
    const existing = await this.db.query.kbResearchBriefs.findFirst({
      where: and(
        eq(kbResearchBriefs.id, briefId),
        eq(kbResearchBriefs.orgId, user.orgId),
        eq(kbResearchBriefs.userId, user.userId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Research brief not found");
    await this.db
      .update(kbResearchBriefs)
      .set({ rating })
      .where(eq(kbResearchBriefs.id, briefId));
  }
}
