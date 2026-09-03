import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { jobBoardPostings } from "../../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { CreateJobBoardPostingInput, UpdateJobBoardPostingInput } from "./dto/job-boards.schemas";
import { jobPostings } from "../../../db/schema";

@Injectable()
export class RecruitmentJobBoardsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, jobPostingId: number) {
    const job = await this.db.query.jobPostings.findFirst({
      columns: { id: true },
      where: and(eq(jobPostings.id, jobPostingId), eq(jobPostings.orgId, orgId)),
    });
    if (!job) throw new NotFoundException("Job posting not found.");
    return this.db.select().from(jobBoardPostings)
      .where(and(eq(jobBoardPostings.orgId, orgId), eq(jobBoardPostings.jobPostingId, jobPostingId)))
      .orderBy(desc(jobBoardPostings.createdAt))
      .limit(100);
  }

  async create(orgId: string, userId: string, jobPostingId: number, data: CreateJobBoardPostingInput) {
    const [posting] = await this.db.insert(jobBoardPostings).values({
      ...data,
      spend: data.spend?.toString(),
      postedAt: data.postedAt ? new Date(data.postedAt) : undefined,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
      orgId,
      jobPostingId,
      createdBy: userId,
      postedBy: data.status === "POSTED" ? userId : undefined,
    }).returning();
    return posting;
  }

  async update(orgId: string, jobPostingId: number, id: number, data: UpdateJobBoardPostingInput) {
    const [posting] = await this.db.update(jobBoardPostings)
      .set({
        ...data,
        spend: data.spend?.toString(),
        postedAt: data.postedAt ? new Date(data.postedAt) : undefined,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : undefined,
        updatedAt: new Date(),
      })
      .where(and(
        eq(jobBoardPostings.id, id),
        eq(jobBoardPostings.jobPostingId, jobPostingId),
        eq(jobBoardPostings.orgId, orgId),
      ))
      .returning();
    if (!posting) throw new NotFoundException("Job board posting not found");
    return posting;
  }

  async remove(orgId: string, jobPostingId: number, id: number) {
    const [posting] = await this.db.delete(jobBoardPostings)
      .where(and(
        eq(jobBoardPostings.id, id),
        eq(jobBoardPostings.jobPostingId, jobPostingId),
        eq(jobBoardPostings.orgId, orgId),
      ))
      .returning();
    if (!posting) throw new NotFoundException("Job board posting not found");
    return { success: true };
  }
}
