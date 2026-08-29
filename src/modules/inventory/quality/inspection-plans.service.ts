import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  invInspectionPlans,
  invInspectionPlanVersions,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type {
  CreateInspectionPlanInput,
  CreatePlanVersionInput,
  ListInspectionPlansQueryInput,
  UpdateInspectionPlanInput,
} from "./dto/inspection-plans.schemas";

/** The driver surfaces the SQLSTATE on an unknown-shaped error object. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const { code } = error;
  return code === "23505";
}

/**
 * D3 — the rule that decides whether an arrival has to be looked at.
 *
 * Two shapes live here and they are deliberately different objects. A **plan**
 * is the stable identity a SKU is matched against; a **version** is the rule the
 * plan carried at a point in time. An inspection records the version, so the
 * standard a completed result was judged against stays legible after somebody
 * tightens the sampling — which is exactly what item 3 of the brief means by
 * "plans versioned".
 *
 * A version is therefore immutable from the moment it leaves DRAFT. `activate`
 * supersedes the live one rather than editing it, and there is no update path
 * for an ACTIVE or SUPERSEDED row at all: `uniq_inv_inspection_plan_versions_active`
 * is what makes "one live rule per plan" true when two publishes race, where a
 * read-then-write check always loses.
 */
@Injectable()
export class InspectionPlansService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string, query: ListInspectionPlansQueryInput) {
    const { search, isActive, appliesOn, productVariantId, page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${search ?? ""}:${isActive ?? ""}:${appliesOn ?? ""}:${productVariantId ?? ""}:${limit}:${offset}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invInspectionPlansNamespace(orgId),
      `list:${hash}`,
      async () => {
        const conditions = [
          eq(invInspectionPlans.orgId, orgId),
          isNull(invInspectionPlans.deletedAt),
        ];
        if (isActive) conditions.push(eq(invInspectionPlans.isActive, isActive === "true"));
        if (appliesOn === "RECEIPT") conditions.push(eq(invInspectionPlans.appliesOnReceipt, true));
        if (appliesOn === "RETURN") conditions.push(eq(invInspectionPlans.appliesOnReturn, true));
        if (productVariantId)
          conditions.push(eq(invInspectionPlans.productVariantId, productVariantId));
        if (search) {
          const pattern = `%${search}%`;
          conditions.push(
            sql`(${invInspectionPlans.code} ILIKE ${pattern} OR ${invInspectionPlans.name} ILIKE ${pattern})`,
          );
        }
        const where = and(...conditions);
        const [items, countResult] = await Promise.all([
          this.db.query.invInspectionPlans.findMany({
            where,
            orderBy: [desc(invInspectionPlans.updatedAt)],
            limit,
            offset,
            columns: {
              id: true, code: true, name: true, description: true,
              productVariantId: true, productId: true, categoryId: true,
              appliesOnReceipt: true, appliesOnReturn: true, isActive: true,
              createdAt: true, updatedAt: true,
            },
            with: {
              versions: {
                where: eq(invInspectionPlanVersions.status, "ACTIVE"),
                columns: { id: true, version: true, samplingMethod: true, sampleValue: true },
                limit: 1,
              },
              productVariant: { columns: { name: true, sku: true } },
              product: { columns: { name: true, sku: true } },
              category: { columns: { name: true } },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invInspectionPlans)
            .where(where),
        ]);
        const total = countResult[0]?.count ?? 0;
        return {
          items: items.map(({ versions, productVariant, product, category, ...plan }) => ({
            ...plan,
            activeVersion: versions[0] ?? null,
            scopeLabel: category?.name ?? productVariant?.sku ?? product?.sku ?? "All products",
          })),
          total,
          page,
          totalPages: Math.ceil(total / limit),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  async findOne(orgId: string, planId: number) {
    const plan = await this.db.query.invInspectionPlans.findFirst({
      where: and(
        eq(invInspectionPlans.id, planId),
        eq(invInspectionPlans.orgId, orgId),
        isNull(invInspectionPlans.deletedAt),
      ),
      with: {
        versions: {
          orderBy: [desc(invInspectionPlanVersions.version)],
          columns: {
            id: true, version: true, samplingMethod: true, sampleValue: true,
            instructions: true, status: true, activatedAt: true, createdAt: true,
          },
        },
      },
    });
    // Cross-tenant and deleted both read as absent: a 403 on another org's id
    // confirms the record exists (backend §4).
    if (!plan) throw new NotFoundException("Inspection plan not found");
    return plan;
  }

  async create(orgId: string, userId: string, input: CreateInspectionPlanInput) {
    const created = await this.createInTx(orgId, userId, input).catch((error: unknown) => {
      // A duplicate plan code is a caller mistake, not a server fault. Left
      // unhandled the driver's 23505 surfaces as a 500 (backend §3).
      if (isUniqueViolation(error))
        throw new ConflictException(`An inspection plan with the code ${input.code} already exists`);
      throw error;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invInspectionPlansNamespace(orgId));
    return this.findOne(orgId, created);
  }

  private createInTx(orgId: string, userId: string, input: CreateInspectionPlanInput) {
    return this.db.transaction(async (tx) => {
      const [plan] = await tx
        .insert(invInspectionPlans)
        .values({
          orgId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          productVariantId: input.productVariantId ?? null,
          productId: input.productId ?? null,
          categoryId: input.categoryId ?? null,
          appliesOnReceipt: input.appliesOnReceipt,
          appliesOnReturn: input.appliesOnReturn,
          createdBy: userId,
        })
        .returning({ id: invInspectionPlans.id });
      if (!plan) throw new ConflictException("Could not create the inspection plan");

      // A plan with no version answers no receipt, so the first one is created
      // and published with it rather than left as a second step somebody forgets.
      await tx.insert(invInspectionPlanVersions).values({
        orgId,
        planId: plan.id,
        version: 1,
        samplingMethod: input.samplingMethod,
        sampleValue: input.sampleValue ?? null,
        instructions: input.instructions ?? null,
        status: "ACTIVE",
        activatedAt: new Date(),
        createdBy: userId,
      });

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "quality_inspection_plan.created",
        resourceType: "inv_inspection_plan",
        resourceId: String(plan.id),
        after: { code: input.code, samplingMethod: input.samplingMethod },
      });
      return plan.id;
    });
  }

  async update(orgId: string, userId: string, planId: number, input: UpdateInspectionPlanInput) {
    const before = await this.findOne(orgId, planId);

    const appliesOnReceipt = input.appliesOnReceipt ?? before.appliesOnReceipt;
    const appliesOnReturn = input.appliesOnReturn ?? before.appliesOnReturn;
    if (!appliesOnReceipt && !appliesOnReturn)
      throw new BadRequestException("A plan that applies to nothing would never be consulted");

    // Scope is exclusive, and a partial update can break that by naming one id
    // while another is already set — so the *resulting* row is what is checked,
    // not the patch.
    const nextScope = {
      productVariantId:
        input.productVariantId === undefined ? before.productVariantId : input.productVariantId,
      productId: input.productId === undefined ? before.productId : input.productId,
      categoryId: input.categoryId === undefined ? before.categoryId : input.categoryId,
    };
    const named = Object.values(nextScope).filter((value) => value !== null).length;
    if (named > 1)
      throw new BadRequestException(
        "A plan targets one of a variant, a product or a category — never several",
      );

    await this.db.transaction(async (tx) => {
      await tx
        .update(invInspectionPlans)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...nextScope,
          appliesOnReceipt,
          appliesOnReturn,
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        })
        .where(and(eq(invInspectionPlans.id, planId), eq(invInspectionPlans.orgId, orgId)));
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "quality_inspection_plan.updated",
        resourceType: "inv_inspection_plan",
        resourceId: String(planId),
        before: { name: before.name, isActive: before.isActive },
        after: { name: input.name ?? before.name, isActive: input.isActive ?? before.isActive },
      });
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invInspectionPlansNamespace(orgId));
    return this.findOne(orgId, planId);
  }

  /**
   * Soft delete, per backend §3. A plan that governed a completed inspection is
   * evidence: hard-deleting it would leave that inspection naming a version whose
   * plan has gone.
   */
  async remove(orgId: string, userId: string, planId: number) {
    await this.findOne(orgId, planId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(invInspectionPlans)
        .set({ deletedAt: new Date(), isActive: false })
        .where(and(eq(invInspectionPlans.id, planId), eq(invInspectionPlans.orgId, orgId)));
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "quality_inspection_plan.deleted",
        resourceType: "inv_inspection_plan",
        resourceId: String(planId),
      });
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invInspectionPlansNamespace(orgId));
    return { deleted: true, planId };
  }

  async addVersion(
    orgId: string,
    userId: string,
    planId: number,
    input: CreatePlanVersionInput,
  ) {
    await this.findOne(orgId, planId);
    const versionId = await this.db.transaction(async (tx) => {
      // The plan row is the serialisation point for its own version numbers:
      // two concurrent publishes otherwise both read the same MAX and collide on
      // the unique index, which is a 500 rather than a queue.
      await tx.execute(
        sql`SELECT id FROM inv_inspection_plans WHERE id = ${planId} AND org_id = ${orgId} FOR UPDATE`,
      );
      const [latest] = await tx
        .select({ version: invInspectionPlanVersions.version })
        .from(invInspectionPlanVersions)
        .where(
          and(
            eq(invInspectionPlanVersions.orgId, orgId),
            eq(invInspectionPlanVersions.planId, planId),
          ),
        )
        .orderBy(desc(invInspectionPlanVersions.version))
        .limit(1);
      const nextVersion = (latest?.version ?? 0) + 1;

      if (input.activate) {
        await tx
          .update(invInspectionPlanVersions)
          .set({ status: "SUPERSEDED" })
          .where(
            and(
              eq(invInspectionPlanVersions.orgId, orgId),
              eq(invInspectionPlanVersions.planId, planId),
              eq(invInspectionPlanVersions.status, "ACTIVE"),
            ),
          );
      }

      const [version] = await tx
        .insert(invInspectionPlanVersions)
        .values({
          orgId,
          planId,
          version: nextVersion,
          samplingMethod: input.samplingMethod,
          sampleValue: input.sampleValue ?? null,
          instructions: input.instructions ?? null,
          status: input.activate ? "ACTIVE" : "DRAFT",
          activatedAt: input.activate ? new Date() : null,
          createdBy: userId,
        })
        .returning({ id: invInspectionPlanVersions.id });
      if (!version) throw new ConflictException("Could not record the plan version");

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "quality_inspection_plan.version_added",
        resourceType: "inv_inspection_plan",
        resourceId: String(planId),
        after: { version: nextVersion, activated: input.activate },
      });
      return version.id;
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invInspectionPlansNamespace(orgId));
    return { planId, versionId };
  }

  /** Publishes a DRAFT version and supersedes whichever one was live. */
  async activateVersion(orgId: string, userId: string, planId: number, versionId: number) {
    await this.findOne(orgId, planId);
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM inv_inspection_plans WHERE id = ${planId} AND org_id = ${orgId} FOR UPDATE`,
      );
      const version = await tx.query.invInspectionPlanVersions.findFirst({
        where: and(
          eq(invInspectionPlanVersions.id, versionId),
          eq(invInspectionPlanVersions.orgId, orgId),
          eq(invInspectionPlanVersions.planId, planId),
        ),
        columns: { id: true, status: true },
      });
      if (!version) throw new NotFoundException("Plan version not found");
      if (version.status === "ACTIVE") return;
      if (version.status === "SUPERSEDED")
        throw new ConflictException(
          "A superseded version is history; publish a new version instead of reviving it",
        );

      await tx
        .update(invInspectionPlanVersions)
        .set({ status: "SUPERSEDED" })
        .where(
          and(
            eq(invInspectionPlanVersions.orgId, orgId),
            eq(invInspectionPlanVersions.planId, planId),
            eq(invInspectionPlanVersions.status, "ACTIVE"),
          ),
        );
      await tx
        .update(invInspectionPlanVersions)
        .set({ status: "ACTIVE", activatedAt: new Date() })
        .where(
          and(
            eq(invInspectionPlanVersions.id, versionId),
            eq(invInspectionPlanVersions.orgId, orgId),
          ),
        );
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "quality_inspection_plan.version_activated",
        resourceType: "inv_inspection_plan",
        resourceId: String(planId),
        after: { versionId },
      });
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invInspectionPlansNamespace(orgId));
    return this.findOne(orgId, planId);
  }

  /** The version rows a plan detail screen orders oldest-first. */
  listVersions(orgId: string, planId: number) {
    return this.db.query.invInspectionPlanVersions.findMany({
      where: and(
        eq(invInspectionPlanVersions.orgId, orgId),
        eq(invInspectionPlanVersions.planId, planId),
      ),
      orderBy: [asc(invInspectionPlanVersions.version)],
      columns: {
        id: true, version: true, samplingMethod: true, sampleValue: true,
        instructions: true, status: true, activatedAt: true, createdAt: true,
      },
    });
  }
}
