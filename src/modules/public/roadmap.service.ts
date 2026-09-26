import { createHmac } from "crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import {
  changelogEntries,
  feedbackPosts,
  feedbackVotes,
  organizations,
  roadmapItems,
  roadmapVotes,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { sanitizeText } from "./public.helpers";
import type {
  RoadmapFeedbackInput,
  RoadmapVoteInput,
} from "./dto/public.schemas";

@Injectable()
export class RoadmapService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  private async resolveBoardOrg(handle: string) {
    const byToken = await this.db.query.organizations.findFirst({
      where: and(
        eq(organizations.roadmapPublicToken, handle),
        isNull(organizations.deletedAt),
      ),
      columns: { id: true, name: true },
    });
    if (byToken) return byToken;

    return this.db.query.organizations.findFirst({
      where: and(eq(organizations.id, handle), isNull(organizations.deletedAt)),
      columns: { id: true, name: true },
    });
  }

  async getRoadmap(handle: string) {
    const org = await this.resolveBoardOrg(handle);
    if (!org) throw new NotFoundException("Board not found");
    const orgId = org.id;

    const [items, posts, changelog] = await Promise.all([
      this.db.query.roadmapItems.findMany({
        where: and(
          eq(roadmapItems.orgId, orgId),
          eq(roadmapItems.isPublic, true),
          isNull(roadmapItems.deletedAt),
        ),
        columns: {
          id: true,
          title: true,
          description: true,
          status: true,
          category: true,
          targetQuarter: true,
          votes: true,
        },
        orderBy: [
          asc(roadmapItems.sortOrder),
          desc(roadmapItems.votes),
          asc(roadmapItems.id),
        ],
      }),
      this.db.query.feedbackPosts.findMany({
        where: and(
          eq(feedbackPosts.orgId, orgId),
          eq(feedbackPosts.status, "open"),
          isNull(feedbackPosts.deletedAt),
        ),
        columns: {
          id: true,
          title: true,
          description: true,
          category: true,
          votes: true,
          createdAt: true,
        },
        orderBy: [desc(feedbackPosts.votes), desc(feedbackPosts.createdAt)],
      }),
      this.db.query.changelogEntries.findMany({
        where: and(
          eq(changelogEntries.orgId, orgId),
          eq(changelogEntries.isPublished, true),
        ),
        columns: {
          id: true,
          title: true,
          content: true,
          version: true,
          type: true,
          publishedAt: true,
        },
        orderBy: [
          desc(changelogEntries.publishedAt),
          desc(changelogEntries.id),
        ],
      }),
    ]);

    return {
      orgName: org.name,
      roadmap: {
        planned: items.filter((i) => i.status === "planned"),
        in_progress: items.filter((i) => i.status === "in_progress"),
        completed: items.filter((i) => i.status === "completed"),
      },
      feedback: posts,
      changelog,
    };
  }

  private hashIp(ip: string): string {
    const secret = this.config.VOTE_IP_SALT ?? this.config.BACKEND_JWT_SECRET;
    if (!secret)
      throw new Error(
        "VOTE_IP_SALT or BACKEND_JWT_SECRET is required to hash voter IPs",
      );
    return createHmac("sha256", secret)
      .update(`roadmap-vote:${ip}`)
      .digest("hex");
  }

  async vote(handle: string, input: RoadmapVoteInput, voterIp?: string) {
    const org = await this.resolveBoardOrg(handle);
    if (!org) throw new NotFoundException("Board not found");
    const orgId = org.id;
    const { type, id, voterKey } = input;
    const voterIpHash = voterIp ? this.hashIp(voterIp) : null;

    if (type === "roadmap") {
      const item = await this.db.query.roadmapItems.findFirst({
        where: and(
          eq(roadmapItems.id, id),
          eq(roadmapItems.orgId, orgId),
          eq(roadmapItems.isPublic, true),
          isNull(roadmapItems.deletedAt),
        ),
        columns: { id: true },
      });
      if (!item) throw new NotFoundException("Item not found");

      const votes = await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(roadmapVotes)
          .values({ orgId, roadmapItemId: id, voterKey, voterIpHash })
          .onConflictDoNothing()
          .returning({ id: roadmapVotes.id });

        if (inserted.length > 0) {
          const [row] = await tx
            .update(roadmapItems)
            .set({ votes: sql`${roadmapItems.votes} + 1` })
            .where(eq(roadmapItems.id, id))
            .returning({ votes: roadmapItems.votes });
          return row?.votes ?? 0;
        }

        const [current] = await tx
          .select({ votes: roadmapItems.votes })
          .from(roadmapItems)
          .where(eq(roadmapItems.id, id))
          .limit(1);
        return current?.votes ?? 0;
      });

      return { id, type, votes, voted: true };
    }

    const post = await this.db.query.feedbackPosts.findFirst({
      where: and(
        eq(feedbackPosts.id, id),
        eq(feedbackPosts.orgId, orgId),
        eq(feedbackPosts.status, "open"),
        isNull(feedbackPosts.deletedAt),
      ),
      columns: { id: true },
    });
    if (!post) throw new NotFoundException("Post not found");

    const votes = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(feedbackVotes)
        .values({ orgId, feedbackPostId: id, voterKey, voterIpHash })
        .onConflictDoNothing()
        .returning({ id: feedbackVotes.id });

      if (inserted.length > 0) {
        const [row] = await tx
          .update(feedbackPosts)
          .set({ votes: sql`${feedbackPosts.votes} + 1` })
          .where(eq(feedbackPosts.id, id))
          .returning({ votes: feedbackPosts.votes });
        return row?.votes ?? 0;
      }

      const [current] = await tx
        .select({ votes: feedbackPosts.votes })
        .from(feedbackPosts)
        .where(eq(feedbackPosts.id, id))
        .limit(1);
      return current?.votes ?? 0;
    });

    return { id, type, votes, voted: true };
  }

  async submitFeedback(handle: string, input: RoadmapFeedbackInput) {
    const org = await this.resolveBoardOrg(handle);
    if (!org) throw new NotFoundException("Board not found");
    const orgId = org.id;

    const { title, description, name, email } = input;

    const [post] = await this.db
      .insert(feedbackPosts)
      .values({
        orgId,
        title: sanitizeText(title),
        description: description ? sanitizeText(description) : null,
        status: "open",
        submittedByName: name ?? null,
        submittedByEmail: email ?? null,
      })
      .returning({ id: feedbackPosts.id });

    return { id: post.id, message: "Feedback submitted" };
  }
}
