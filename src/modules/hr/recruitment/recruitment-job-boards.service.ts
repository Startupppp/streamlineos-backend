import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { jobBoardPostings } from "../../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { CreateJobBoardPostingInput, UpdateJobBoardPostingInput } from "./dto/job-boards.schemas";
import { jobPostings } from "../../../db/schema";

/**
 * `job_board_postings` is a MANUAL LOG, not a distribution channel.
 *
 * Nothing here contacts a board. A recruiter posts the job on LinkedIn or
 * Naukri themselves and records the link, the spend and the applicant counts so
 * the source-of-hire reporting has numbers. Its `status` column holding the
 * word `POSTED` therefore records what the recruiter did, and is not a claim
 * that this system posted anything — the screen it feeds says so, and
 * `boards/job-board-adapters.ts` is where an actual integration would go.
 */
@Injectable()
export class RecruitmentJobBoardsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The job posting named in the path, resolved under the caller's organisation.
   *
   * `list` did this and `create` did not, so a cross-tenant `:jobId` reached the INSERT and the
   * composite tenant FK refused it with an uncaught 23503 — a **500** where the contract requires
   * 404, measured by the live cross-tenant sweep (control 201, cross-tenant 500).
   */
  private async assertJobPostingInOrg(orgId: string, jobPostingId: number): Promise<void> {
    const job = await this.db.query.jobPostings.findFirst({
      columns: { id: true },
      where: and(eq(jobPostings.id, jobPostingId), eq(jobPostings.orgId, orgId)),
    });
    if (!job) throw new NotFoundException("Job posting not found.");
  }

  async list(orgId: string, jobPostingId: number) {
    await this.assertJobPostingInOrg(orgId, jobPostingId);
    return this.db.select().from(jobBoardPostings)
      .where(and(eq(jobBoardPostings.orgId, orgId), eq(jobBoardPostings.jobPostingId, jobPostingId)))
      .orderBy(desc(jobBoardPostings.createdAt))
      .limit(100);
  }

  async create(orgId: string, userId: string, jobPostingId: number, data: CreateJobBoardPostingInput) {
    await this.assertJobPostingInOrg(orgId, jobPostingId);
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
