import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrPositionStatuses } from "../../../../db/schema";
import type {
  CreatePositionStatusInput,
  UpdatePositionStatusInput,
} from "./positions-taxonomy.dto";
import { isUniqueViolation } from "../../../../common/db/postgres-error";

@Injectable()
export class PositionsTaxonomyService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listStatuses(orgId: string) {
    return this.db
      .select()
      .from(hrPositionStatuses)
      .where(eq(hrPositionStatuses.orgId, orgId))
      .orderBy(asc(hrPositionStatuses.order), asc(hrPositionStatuses.name))
      .limit(100);
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
      .catch((err: unknown) => {
        if (isUniqueViolation(err))
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
}
