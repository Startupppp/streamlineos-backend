import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import {
  feedbucketSubmissions,
  feedbucketWidgets,
  feedbackPosts,
  managedProducts,
  projects,
  roadmapItems,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type {
  CreateManagedProductInput,
  ListManagedProductsQuery,
  UpdateManagedProductInput,
} from "./dto/managed-products.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";

type ManagedProductRow = typeof managedProducts.$inferSelect;
type ManagedProductPatch = Partial<typeof managedProducts.$inferInsert>;

@Injectable()
export class ManagedProductsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async loadProduct(orgId: string, managedProductId: number): Promise<ManagedProductRow> {
    const [row] = await this.db
      .select()
      .from(managedProducts)
      .where(
        and(
          eq(managedProducts.id, managedProductId),
          eq(managedProducts.orgId, orgId),
          isNull(managedProducts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Managed product not found");
    return row;
  }

  async listManagedProducts(
    orgId: string,
    query: ListManagedProductsQuery,
    _callerMembershipId: number | null,
  ) {
    const { cursor, limit, status } = query;
    const pos = decodeCursor(cursor);
    if (cursor !== undefined && pos === null) {
      throw new BadRequestException("Invalid pagination cursor");
    }
    const conds = [
      eq(managedProducts.orgId, orgId),
      isNull(managedProducts.deletedAt),
      status ? eq(managedProducts.status, status) : undefined,
      query.search ? ilike(managedProducts.name, `%${query.search}%`) : undefined,
    ];
    if (pos) conds.push(keysetBeforeId(managedProducts.createdAt, managedProducts.id, pos));

    const rows = await this.db
      .select()
      .from(managedProducts)
      .where(and(...conds))
      .orderBy(desc(managedProducts.createdAt), desc(managedProducts.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }

  async getManagedProduct(orgId: string, managedProductId: number) {
    return this.loadProduct(orgId, managedProductId);
  }

  async createManagedProduct(
    orgId: string,
    userId: string,
    _callerMembershipId: number | null,
    input: CreateManagedProductInput,
  ) {
    const [row] = await this.db
      .insert(managedProducts)
      .values({
        orgId,
        name: input.name,
        key: input.key,
        description: input.description ?? null,
        ownerId: input.ownerId ?? null,
        status: "active",
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A managed product with key "${input.key}" already exists in this organization.`,
          );
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create managed product");
    this.audit.log({
      action: "managed_product.created",
      userId,
      orgId,
      resourceType: "managed_product",
      resourceId: String(row.id),
      metadata: { managedProductId: row.id, name: row.name, key: row.key },
    });
    return row;
  }

  async updateManagedProduct(
    orgId: string,
    userId: string,
    managedProductId: number,
    input: UpdateManagedProductInput,
  ) {
    await this.loadProduct(orgId, managedProductId);
    const patch: ManagedProductPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.ownerId !== undefined) patch.ownerId = input.ownerId ?? null;
    if (input.status !== undefined) patch.status = input.status;
    const [updated] = await this.db
      .update(managedProducts)
      .set(patch)
      .where(
        and(
          eq(managedProducts.id, managedProductId),
          eq(managedProducts.orgId, orgId),
          isNull(managedProducts.deletedAt),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Managed product not found");
    this.audit.log({
      action: "managed_product.updated",
      userId,
      orgId,
      resourceType: "managed_product",
      resourceId: String(managedProductId),
      metadata: { managedProductId },
    });
    return updated;
  }

  async getProductInsights(orgId: string, managedProductId: number) {
    await this.loadProduct(orgId, managedProductId);

    const [projectRows, submissionRows, roadmapRows, feedbackRows] = await Promise.all([
      this.db
        .select({ status: projects.status, tally: count() })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, orgId),
            eq(projects.managedProductId, managedProductId),
            isNull(projects.deletedAt),
          ),
        )
        .groupBy(projects.status),

      this.db
        .select({ status: feedbucketSubmissions.status, tally: count() })
        .from(feedbucketSubmissions)
        .innerJoin(
          feedbucketWidgets,
          and(
            eq(feedbucketSubmissions.widgetId, feedbucketWidgets.id),
            eq(feedbucketSubmissions.orgId, feedbucketWidgets.orgId),
          ),
        )
        .where(
          and(
            eq(feedbucketSubmissions.orgId, orgId),
            eq(feedbucketWidgets.managedProductId, managedProductId),
            isNull(feedbucketSubmissions.deletedAt),
            isNull(feedbucketWidgets.deletedAt),
          ),
        )
        .groupBy(feedbucketSubmissions.status),

      this.db
        .select({ status: roadmapItems.status, tally: count() })
        .from(roadmapItems)
        .innerJoin(
          projects,
          and(
            eq(projects.orgId, roadmapItems.orgId),
            eq(projects.id, roadmapItems.projectId),
            eq(projects.managedProductId, managedProductId),
            isNull(projects.deletedAt),
          ),
        )
        .where(and(eq(roadmapItems.orgId, orgId), isNull(roadmapItems.deletedAt)))
        .groupBy(roadmapItems.status),

      this.db
        .select({ status: feedbackPosts.status, tally: count(), votes: sql<number>`COALESCE(SUM(${feedbackPosts.votes}), 0)::int`.mapWith(Number) })
        .from(feedbackPosts)
        .innerJoin(
          roadmapItems,
          and(
            eq(roadmapItems.orgId, feedbackPosts.orgId),
            eq(roadmapItems.id, feedbackPosts.linkedRoadmapItemId),
            isNull(roadmapItems.deletedAt),
          ),
        )
        .innerJoin(
          projects,
          and(
            eq(projects.orgId, roadmapItems.orgId),
            eq(projects.id, roadmapItems.projectId),
            eq(projects.managedProductId, managedProductId),
            isNull(projects.deletedAt),
          ),
        )
        .where(
          and(
            eq(feedbackPosts.orgId, orgId),
            isNull(feedbackPosts.deletedAt),
            isNull(feedbackPosts.duplicateOfId),
          ),
        )
        .groupBy(feedbackPosts.status),
    ]);

    const projectsByStatus = { active: 0, completed: 0, archived: 0 };
    for (const row of projectRows) {
      const n = Number(row.tally);
      if (row.status === "ACTIVE") projectsByStatus.active = n;
      else if (row.status === "COMPLETED") projectsByStatus.completed = n;
      else if (row.status === "ARCHIVED") projectsByStatus.archived = n;
    }

    const submissionsByStatus = { open: 0, in_progress: 0, resolved: 0, archived: 0 };
    for (const row of submissionRows) {
      const n = Number(row.tally);
      const key = row.status as keyof typeof submissionsByStatus;
      if (key in submissionsByStatus) submissionsByStatus[key] = n;
    }

    const roadmapItemsByStatus = { planned: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const row of roadmapRows) {
      const key = row.status as keyof typeof roadmapItemsByStatus;
      if (key in roadmapItemsByStatus) roadmapItemsByStatus[key] = Number(row.tally);
    }

    const feedbackByStatus = { open: 0, planned: 0, in_progress: 0, completed: 0, declined: 0 };
    let linkedFeedbackVoteCount = 0;
    for (const row of feedbackRows) {
      const key = row.status as keyof typeof feedbackByStatus;
      if (key in feedbackByStatus) feedbackByStatus[key] = Number(row.tally);
      linkedFeedbackVoteCount += Number(row.votes ?? 0);
    }

    return {
      linkedProjectCount: projectsByStatus.active + projectsByStatus.completed + projectsByStatus.archived,
      projectsByStatus,
      submissionsByStatus,
      roadmapItemCount: Object.values(roadmapItemsByStatus).reduce((total, value) => total + value, 0),
      roadmapItemsByStatus,
      feedbackByStatus,
      linkedFeedbackVoteCount,
    };
  }

  async deleteManagedProduct(orgId: string, userId: string, managedProductId: number) {
    await this.loadProduct(orgId, managedProductId);
    await this.db
      .update(managedProducts)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(managedProducts.id, managedProductId),
          eq(managedProducts.orgId, orgId),
          isNull(managedProducts.deletedAt),
        ),
      );
    this.audit.log({
      action: "managed_product.deleted",
      userId,
      orgId,
      resourceType: "managed_product",
      resourceId: String(managedProductId),
      metadata: { managedProductId },
    });
  }
}
