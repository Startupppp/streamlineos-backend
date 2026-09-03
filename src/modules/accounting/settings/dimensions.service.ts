import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { accountingDimensions, accountingDimensionValues } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreateDimensionInput,
  UpdateDimensionInput,
  CreateDimensionValueInput,
  UpdateDimensionValueInput,
} from "./dto/dimensions.schemas";
import { hasPatchValues } from "../../../common/db/patch-values";
import { isUniqueViolation } from "../../../common/db/postgres-error";

const DIMENSIONS_CACHE_KEY = (orgId: string) => `acc:dimensions:${orgId}`;
const DIMENSIONS_PAGE_SIZE = 100;
const DIMENSION_VALUES_PAGE_SIZE = 500;

@Injectable()
export class DimensionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listDimensions(orgId: string) {
    return this.cache.cached(
      DIMENSIONS_CACHE_KEY(orgId),
      async () => {
        const dims = await this.db
          .select({
            id: accountingDimensions.id,
            name: accountingDimensions.name,
            key: accountingDimensions.key,
            requiredForAccountTypes: accountingDimensions.requiredForAccountTypes,
            isActive: accountingDimensions.isActive,
            createdAt: accountingDimensions.createdAt,
          })
          .from(accountingDimensions)
          .where(eq(accountingDimensions.orgId, orgId))
          .orderBy(accountingDimensions.name)
          .limit(DIMENSIONS_PAGE_SIZE + 1);

        if (dims.length > DIMENSIONS_PAGE_SIZE) {
          throw new BadRequestException(
            `This organisation has more than ${DIMENSIONS_PAGE_SIZE} accounting dimensions; narrow the configuration before loading it.`,
          );
        }

        const valueCounts = await this.db
          .select({
            dimensionId: accountingDimensionValues.dimensionId,
            total: count(),
          })
          .from(accountingDimensionValues)
          .where(eq(accountingDimensionValues.orgId, orgId))
          .groupBy(accountingDimensionValues.dimensionId);

        const countMap = new Map(valueCounts.map((r) => [r.dimensionId, r.total]));

        return {
          items: dims.map((d) => ({
            ...d,
            valueCount: countMap.get(d.id) ?? 0,
          })),
        };
      },
      120,
    );
  }

  async createDimension(u: CurrentUserContext, input: CreateDimensionInput) {
    try {
      const [dim] = await this.db
        .insert(accountingDimensions)
        .values({
          orgId: u.orgId,
          name: input.name,
          key: input.key,
          requiredForAccountTypes: input.requiredForAccountTypes ?? [],
        })
        .returning();

      if (!dim) throw new InternalServerErrorException("Failed to create dimension.");

      await this.cache.invalidate(DIMENSIONS_CACHE_KEY(u.orgId));

      this.audit.log({
        action: "accounting.dimension.created",
        userId: u.userId,
        orgId: u.orgId,
        resourceType: "accounting_dimension",
        resourceId: String(dim.id),
        after: { name: input.name, key: input.key },
      });

      return dim;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A dimension with key "${input.key}" already exists in this organisation.`,
        );
      }
      throw err;
    }
  }

  async updateDimension(u: CurrentUserContext, dimensionId: number, input: UpdateDimensionInput) {
    const [existing] = await this.db
      .select({ id: accountingDimensions.id })
      .from(accountingDimensions)
      .where(and(eq(accountingDimensions.id, dimensionId), eq(accountingDimensions.orgId, u.orgId)))
      .limit(1);

    if (!existing) throw new NotFoundException(`Dimension ${dimensionId} not found`);

    const scope = and(eq(accountingDimensions.id, dimensionId), eq(accountingDimensions.orgId, u.orgId));
    const [updated] = hasPatchValues(input)
      ? await this.db.update(accountingDimensions).set({ ...input }).where(scope).returning()
      : await this.db.select().from(accountingDimensions).where(scope).limit(1);

    if (!updated) throw new InternalServerErrorException("Failed to update dimension.");

    await this.cache.invalidate(DIMENSIONS_CACHE_KEY(u.orgId));

    this.audit.log({
      action: "accounting.dimension.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "accounting_dimension",
      resourceId: String(dimensionId),
      after: { ...input },
    });

    return updated;
  }

  async listValues(orgId: string, dimensionId: number) {
    const [dim] = await this.db
      .select({ id: accountingDimensions.id })
      .from(accountingDimensions)
      .where(and(eq(accountingDimensions.id, dimensionId), eq(accountingDimensions.orgId, orgId)))
      .limit(1);

    if (!dim) throw new NotFoundException(`Dimension ${dimensionId} not found`);

    const rows = await this.db
      .select()
      .from(accountingDimensionValues)
      .where(
        and(
          eq(accountingDimensionValues.orgId, orgId),
          eq(accountingDimensionValues.dimensionId, dimensionId),
        ),
      )
      .orderBy(accountingDimensionValues.code)
        .limit(DIMENSION_VALUES_PAGE_SIZE + 1);

    if (rows.length > DIMENSION_VALUES_PAGE_SIZE) {
      throw new BadRequestException(
        `This dimension has more than ${DIMENSION_VALUES_PAGE_SIZE} values; use a filtered value lookup before loading it.`,
      );
    }

    return { items: rows };
  }

  async createValue(
    u: CurrentUserContext,
    dimensionId: number,
    input: CreateDimensionValueInput,
  ) {
    const [dim] = await this.db
      .select({ id: accountingDimensions.id })
      .from(accountingDimensions)
      .where(and(eq(accountingDimensions.id, dimensionId), eq(accountingDimensions.orgId, u.orgId)))
      .limit(1);

    if (!dim) throw new NotFoundException(`Dimension ${dimensionId} not found`);

    try {
      const [val] = await this.db
        .insert(accountingDimensionValues)
        .values({
          orgId: u.orgId,
          dimensionId,
          name: input.name,
          code: input.code,
        })
        .returning();

      if (!val) throw new InternalServerErrorException("Failed to create dimension value.");

      await this.cache.invalidate(DIMENSIONS_CACHE_KEY(u.orgId));

      this.audit.log({
        action: "accounting.dimension_value.created",
        userId: u.userId,
        orgId: u.orgId,
        resourceType: "accounting_dimension_value",
        resourceId: String(val.id),
        after: { dimensionId, name: input.name, code: input.code },
      });

      return val;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A value with code "${input.code}" already exists for this dimension.`,
        );
      }
      throw err;
    }
  }

  async updateValue(
    u: CurrentUserContext,
    dimensionId: number,
    valueId: number,
    input: UpdateDimensionValueInput,
  ) {
    const [val] = await this.db
      .select({ id: accountingDimensionValues.id })
      .from(accountingDimensionValues)
      .where(
        and(
          eq(accountingDimensionValues.id, valueId),
          eq(accountingDimensionValues.dimensionId, dimensionId),
          eq(accountingDimensionValues.orgId, u.orgId),
        ),
      )
      .limit(1);

    if (!val) throw new NotFoundException(`Value ${valueId} not found`);

    const valueScope = and(
      eq(accountingDimensionValues.id, valueId),
      eq(accountingDimensionValues.dimensionId, dimensionId),
      eq(accountingDimensionValues.orgId, u.orgId),
    );
    const [updated] = hasPatchValues(input)
      ? await this.db.update(accountingDimensionValues).set({ ...input }).where(valueScope).returning()
      : await this.db.select().from(accountingDimensionValues).where(valueScope).limit(1);

    if (!updated) throw new InternalServerErrorException("Failed to update dimension value.");

    this.audit.log({
      action: "accounting.dimension_value.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "accounting_dimension_value",
      resourceId: String(valueId),
      after: { ...input },
    });

    return updated;
  }
}
