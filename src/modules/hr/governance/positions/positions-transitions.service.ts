import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrPositionStatuses, hrPositionTransitions } from "../../../../db/schema";
import type {
  CreatePositionTransitionInput,
  UpdatePositionTransitionInput,
} from "./positions-taxonomy.dto";

@Injectable()
export class PositionsTransitionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
      .orderBy(asc(hrPositionTransitions.id))
      .limit(100);
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

    if (!row) throw new NotFoundException("Transition not found");
    return row;
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

    if (!updated) throw new NotFoundException("Transition not found");
    return updated;
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
