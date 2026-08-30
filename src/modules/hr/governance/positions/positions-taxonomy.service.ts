import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrPositionStatuses, hrPositionTransitions } from "../../../../db/schema";
import type {
  CreatePositionStatusInput,
  UpdatePositionStatusInput,
  CreatePositionTransitionInput,
  UpdatePositionTransitionInput,
} from "./positions-taxonomy.dto";

@Injectable()
export class PositionsTaxonomyService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listStatuses(orgId: string) {
    return this.db
      .select()
      .from(hrPositionStatuses)
      .where(eq(hrPositionStatuses.orgId, orgId))
      .orderBy(asc(hrPositionStatuses.order), asc(hrPositionStatuses.name));
  }

  async createStatus(orgId: string, input: CreatePositionStatusInput) {
    const [maxRow] = await this.db
      .select({
        maxOrder: sql<number>`COALESCE(MAX(${hrPositionStatuses.order}), -1)`,
      })
      .from(hrPositionStatuses)
      .where(eq(hrPositionStatuses.orgId, orgId));

    const nextOrder = input.order ?? (maxRow?.maxOrder ?? -1) + 1;

    const [row] = await this.db
      .insert(hrPositionStatuses)
      .values({
        orgId,
        name: input.name,
        order: nextOrder,
        color: input.color ?? null,
        lifecycleGroup: input.lifecycleGroup ?? "unstarted",
        isActive: true,
      })
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === "23505")
          throw new ConflictException(
            `A status named '${input.name}' already exists in this organisation.`,
          );
        throw err;
      });

    return row!;
  }

  async updateStatus(
    orgId: string,
    statusId: number,
    input: UpdatePositionStatusInput,
  ) {
    const [existing] = await this.db
      .select()
      .from(hrPositionStatuses)
      .where(
        and(
          eq(hrPositionStatuses.orgId, orgId),
          eq(hrPositionStatuses.id, statusId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Position status not found");

    if (input.name !== undefined && input.name !== existing.name) {
      const [dup] = await this.db
        .select({ id: hrPositionStatuses.id })
        .from(hrPositionStatuses)
        .where(
          and(
            eq(hrPositionStatuses.orgId, orgId),
            eq(hrPositionStatuses.name, input.name),
            ne(hrPositionStatuses.id, statusId),
          ),
        )
        .limit(1);
      if (dup)
        throw new ConflictException(
          `A status named '${input.name}' already exists in this organisation.`,
        );
    }

    const [updated] = await this.db
      .update(hrPositionStatuses)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.order !== undefined && { order: input.order }),
        ...(input.color !== undefined && { color: input.color }),
        ...(input.lifecycleGroup !== undefined && {
          lifecycleGroup: input.lifecycleGroup,
        }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrPositionStatuses.orgId, orgId),
          eq(hrPositionStatuses.id, statusId),
        ),
      )
      .returning();

    return updated!;
  }

  async retireStatus(orgId: string, statusId: number) {
    const [existing] = await this.db
      .select()
      .from(hrPositionStatuses)
      .where(
        and(
          eq(hrPositionStatuses.orgId, orgId),
          eq(hrPositionStatuses.id, statusId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Position status not found");
    if (!existing.isActive)
      throw new BadRequestException("Status is already retired");

    const [countRow] = await this.db
      .select({ cnt: count() })
      .from(hrPositionStatuses)
      .where(
        and(
          eq(hrPositionStatuses.orgId, orgId),
          eq(hrPositionStatuses.isActive, true),
        ),
      );

    if ((countRow?.cnt ?? 1) <= 1)
      throw new BadRequestException("At least one active status is required");

    await this.db
      .update(hrPositionStatuses)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(hrPositionStatuses.orgId, orgId),
          eq(hrPositionStatuses.id, statusId),
        ),
      );

    return { retired: true };
  }

  async listTransitions(orgId: string) {
    return this.db
      .select()
      .from(hrPositionTransitions)
      .where(
        and(
          eq(hrPositionTransitions.orgId, orgId),
          isNull(hrPositionTransitions.deletedAt),
        ),
      )
      .orderBy(asc(hrPositionTransitions.id));
  }

  async createTransition(
    orgId: string,
    userId: string,
    input: CreatePositionTransitionInput,
  ) {
    await this.assertStatusBelongsToOrg(orgId, input.toStatusId);
    if (input.fromStatusId != null)
      await this.assertStatusBelongsToOrg(orgId, input.fromStatusId);

    const [row] = await this.db
      .insert(hrPositionTransitions)
      .values({
        orgId,
        fromStatusId: input.fromStatusId ?? null,
        toStatusId: input.toStatusId,
        name: input.name ?? null,
        requiresApproval: input.requiresApproval ?? false,
        requiredFields: input.requiredFields ?? [],
        allowedRoles: input.allowedRoles ?? [],
        createdBy: userId,
      })
      .returning();

    return row!;
  }

  async updateTransition(
    orgId: string,
    transitionId: number,
    input: UpdatePositionTransitionInput,
  ) {
    const [existing] = await this.db
      .select()
      .from(hrPositionTransitions)
      .where(
        and(
          eq(hrPositionTransitions.orgId, orgId),
          eq(hrPositionTransitions.id, transitionId),
          isNull(hrPositionTransitions.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Transition not found");

    if (input.toStatusId !== undefined)
      await this.assertStatusBelongsToOrg(orgId, input.toStatusId);
    if (input.fromStatusId != null)
      await this.assertStatusBelongsToOrg(orgId, input.fromStatusId);

    const [updated] = await this.db
      .update(hrPositionTransitions)
      .set({
        ...(input.fromStatusId !== undefined && {
          fromStatusId: input.fromStatusId,
        }),
        ...(input.toStatusId !== undefined && { toStatusId: input.toStatusId }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.requiresApproval !== undefined && {
          requiresApproval: input.requiresApproval,
        }),
        ...(input.requiredFields !== undefined && {
          requiredFields: input.requiredFields,
        }),
        ...(input.allowedRoles !== undefined && {
          allowedRoles: input.allowedRoles,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrPositionTransitions.orgId, orgId),
          eq(hrPositionTransitions.id, transitionId),
        ),
      )
      .returning();

    return updated!;
  }

  async deleteTransition(orgId: string, transitionId: number) {
    const [existing] = await this.db
      .select({ id: hrPositionTransitions.id })
      .from(hrPositionTransitions)
      .where(
        and(
          eq(hrPositionTransitions.orgId, orgId),
          eq(hrPositionTransitions.id, transitionId),
          isNull(hrPositionTransitions.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Transition not found");

    await this.db
      .update(hrPositionTransitions)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(hrPositionTransitions.orgId, orgId),
          eq(hrPositionTransitions.id, transitionId),
        ),
      );
  }

  private async assertStatusBelongsToOrg(
    orgId: string,
    statusId: number,
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: hrPositionStatuses.id })
      .from(hrPositionStatuses)
      .where(
        and(
          eq(hrPositionStatuses.orgId, orgId),
          eq(hrPositionStatuses.id, statusId),
        ),
      )
      .limit(1);
    if (!row)
      throw new BadRequestException(
        `Status ${statusId} does not belong to this organisation`,
      );
  }
}
