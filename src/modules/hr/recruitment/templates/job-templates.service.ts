import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { jobTemplates, organizationMembers } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { PAGE_SIZE_CAP } from "../../../../common/pagination/list-query.schema";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../../common/pagination/keyset";
import { isUniqueViolation } from "../../../../common/db/postgres-error";
import type { ScreeningQuestion } from "../../../../db/schema/hr/hiring-core";
import type {
  ApplyJobTemplateInput,
  CreateJobTemplateInput,
  JobTemplateListInput,
  UpdateJobTemplateInput,
} from "./job-templates.schemas";

/**
 * The projection every read of this table shares.
 *
 * `org_id` and `deleted_at` are deliberately absent: the caller already knows
 * its own tenant, and a `deleted_at` on the wire invites a client to filter on
 * it instead of trusting the server to have done so.
 */
const TEMPLATE_COLUMNS = {
  id: jobTemplates.id,
  name: jobTemplates.name,
  title: jobTemplates.title,
  description: jobTemplates.description,
  requirements: jobTemplates.requirements,
  benefits: jobTemplates.benefits,
  type: jobTemplates.type,
  experience: jobTemplates.experience,
  screeningQuestions: jobTemplates.screeningQuestions,
  jobLevelId: jobTemplates.jobLevelId,
  createdAt: jobTemplates.createdAt,
  updatedAt: jobTemplates.updatedAt,
} as const;

export interface JobTemplateRow {
  id: number;
  name: string;
  title: string | null;
  description: string | null;
  requirements: string | null;
  benefits: string | null;
  type: string;
  experience: string | null;
  screeningQuestions: ScreeningQuestion[] | null;
  jobLevelId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The create screen's draft after the template has filled its gaps.
 *
 * `type` widens to `string` because the stored column is text: the enum lives
 * on the request boundary, and re-narrowing a value the database handed back
 * would need an assertion the repo does not allow.
 */
export interface AppliedJobTemplate {
  jobTemplateId: number;
  jobTemplateName: string;
  draft: Omit<ApplyJobTemplateInput, "type"> & { type?: string };
}

/** The fields a template and a posting draft both own — the only ones the merge touches. */
type MergedField =
  | "title"
  | "description"
  | "requirements"
  | "benefits"
  | "type"
  | "experience"
  | "screeningQuestions";

@Injectable()
export class JobTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(
    orgId: string,
    params: JobTemplateListInput,
  ): Promise<CursorPage<JobTemplateRow>> {
    const limit = Math.min(params.limit, PAGE_SIZE_CAP);
    const position = decodeCursor(params.cursor);

    const rows = await this.db
      .select(TEMPLATE_COLUMNS)
      .from(jobTemplates)
      .where(
        and(
          eq(jobTemplates.orgId, orgId),
          isNull(jobTemplates.deletedAt),
          params.type ? eq(jobTemplates.type, params.type) : undefined,
          position
            ? keysetBeforeId(jobTemplates.createdAt, jobTemplates.id, position)
            : undefined,
        ),
      )
      .orderBy(desc(jobTemplates.createdAt), desc(jobTemplates.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  async getOne(orgId: string, jobTemplateId: number): Promise<JobTemplateRow> {
    const [template] = await this.db
      .select(TEMPLATE_COLUMNS)
      .from(jobTemplates)
      .where(
        and(
          eq(jobTemplates.id, jobTemplateId),
          eq(jobTemplates.orgId, orgId),
          isNull(jobTemplates.deletedAt),
        ),
      )
      .limit(1);
    if (!template) throw new NotFoundException("Job template not found");
    return template;
  }

  async create(
    orgId: string,
    userId: string,
    input: CreateJobTemplateInput,
  ): Promise<JobTemplateRow> {
    const createdByMembershipId = await this.membershipIdOf(orgId, userId);

    const [template] = await this.asConflict(() =>
      this.db
        .insert(jobTemplates)
        .values({
          orgId,
          name: input.name,
          title: input.title,
          description: input.description,
          requirements: input.requirements,
          benefits: input.benefits,
          type: input.type ?? "FULL_TIME",
          experience: input.experience,
          screeningQuestions: input.screeningQuestions,
          jobLevelId: input.jobLevelId,
          createdByMembershipId,
        })
        .returning(TEMPLATE_COLUMNS),
    );
    return template;
  }

  async update(
    orgId: string,
    jobTemplateId: number,
    input: UpdateJobTemplateInput,
  ): Promise<JobTemplateRow> {
    /**
     * An empty PATCH would otherwise reach Drizzle as `set {}`, which is a
     * syntax error rather than a no-op — a 500 for a request that asked for
     * nothing.
     */
    if (Object.keys(input).length === 0) return this.getOne(orgId, jobTemplateId);

    const [template] = await this.asConflict(() =>
      this.db
        .update(jobTemplates)
        .set({ ...input, updatedAt: new Date() })
        .where(
          and(
            eq(jobTemplates.id, jobTemplateId),
            eq(jobTemplates.orgId, orgId),
            isNull(jobTemplates.deletedAt),
          ),
        )
        .returning(TEMPLATE_COLUMNS),
    );
    if (!template) throw new NotFoundException("Job template not found");
    return template;
  }

  /**
   * Soft delete, which frees the name for a replacement because the unique
   * index is partial on `deleted_at IS NULL`.
   *
   * `isNull` in the predicate as well as the projection: without it a second
   * delete would report success and silently move `deleted_at` forward, which
   * reads to a caller as though the row had just been deleted twice.
   */
  async remove(orgId: string, jobTemplateId: number): Promise<void> {
    const [deleted] = await this.db
      .update(jobTemplates)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(jobTemplates.id, jobTemplateId),
          eq(jobTemplates.orgId, orgId),
          isNull(jobTemplates.deletedAt),
        ),
      )
      .returning({ id: jobTemplates.id });
    if (!deleted) throw new NotFoundException("Job template not found");
  }

  /**
   * Fills the gaps in a half-typed posting from the template, and nothing else.
   *
   * The direction is the whole point: a recruiter who picks a template after
   * typing a title keeps their title. Overwriting it would make the picker
   * destructive, so nobody would use it once they had typed anything.
   */
  async applyToJob(
    orgId: string,
    jobTemplateId: number,
    draft: ApplyJobTemplateInput,
  ): Promise<AppliedJobTemplate> {
    const template = await this.getOne(orgId, jobTemplateId);

    /**
     * Key presence, not truthiness. `draft.title ?? template.title` would hand
     * the template's value back for any field the caller set to null, which is
     * the caller being overruled — the one outcome this must never produce.
     * `.strict()` drops an omitted key entirely, so `in` is exactly the
     * question "did the caller say anything about this field".
     */
    const said = (field: MergedField): boolean =>
      Object.prototype.hasOwnProperty.call(draft, field) && draft[field] !== undefined;

    return {
      jobTemplateId: template.id,
      jobTemplateName: template.name,
      draft: {
        // Every field the template has no opinion on — location, salary, the
        // lifecycle columns it deliberately omits — passes through untouched.
        ...draft,
        title: said("title") ? draft.title : (template.title ?? undefined),
        description: said("description") ? draft.description : (template.description ?? undefined),
        requirements: said("requirements")
          ? draft.requirements
          : (template.requirements ?? undefined),
        benefits: said("benefits") ? draft.benefits : (template.benefits ?? undefined),
        type: said("type") ? draft.type : template.type,
        experience: said("experience") ? draft.experience : (template.experience ?? undefined),
        screeningQuestions: said("screeningQuestions")
          ? draft.screeningQuestions
          : (template.screeningQuestions ?? undefined),
      },
    };
  }

  /**
   * `uq_job_templates_org_name` is composite and partial, so the 409 it earns
   * means "you already have a live template with this name" — never "somebody
   * else on the platform took it". Raised as a conflict rather than left to
   * surface as a 500, per BE-41.
   */
  private async asConflict<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("A job template with this name already exists");
      }
      throw error;
    }
  }

  /**
   * The author's membership, not their user id: the column is a composite FK to
   * `(org_id, id)` on `organization_members`, so a person who leaves the org has
   * the reference cleared rather than pointing at a stranger's row.
   */
  private async membershipIdOf(orgId: string, userId: string): Promise<number | null> {
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    return member?.id ?? null;
  }
}
