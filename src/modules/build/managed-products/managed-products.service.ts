import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { managedProducts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PmWorkspacesService } from "../pm-workspaces/pm-workspaces.service";
import type {
  CreateManagedProductInput,
  ListManagedProductsQuery,
  UpdateManagedProductInput,
} from "./dto/managed-products.schemas";

const PG_UNIQUE_VIOLATION = "23505";

type ManagedProductRow = typeof managedProducts.$inferSelect;
type ManagedProductPatch = Partial<typeof managedProducts.$inferInsert>;

@Injectable()
export class ManagedProductsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly pmWorkspaces: PmWorkspacesService,
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

  async listManagedProducts(orgId: string, query: ListManagedProductsQuery) {
    const { page, limit, status } = query;
    const offset = (page - 1) * limit;

    const conditions = and(
      eq(managedProducts.orgId, orgId),
      isNull(managedProducts.deletedAt),
      status ? eq(managedProducts.status, status) : undefined,
    );

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(managedProducts)
        .where(conditions)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(managedProducts).where(conditions),
    ]);

    const total = Number(totalRow?.total ?? 0);
    return {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getManagedProduct(orgId: string, managedProductId: number) {
    return this.loadProduct(orgId, managedProductId);
  }

  async createManagedProduct(orgId: string, userId: string, input: CreateManagedProductInput) {
    const pmWorkspaceId = await this.pmWorkspaces.resolveDefaultWorkspaceId(orgId);
    const [row] = await this.db
      .insert(managedProducts)
      .values({
        orgId,
        pmWorkspaceId,
        name: input.name,
        key: input.key,
        description: input.description ?? null,
        ownerId: input.ownerId ?? null,
        status: "active",
      })
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
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

  async deleteManagedProduct(orgId: string, userId: string, managedProductId: number) {
    await this.loadProduct(orgId, managedProductId);
    await this.db
      .update(managedProducts)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(managedProducts.id, managedProductId),
          eq(managedProducts.orgId, orgId),
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
