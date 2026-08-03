import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { crmProducts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateProductInput, UpdateProductInput } from "./dto/products.schemas";

function escapeLike(input: string): string {
  return input.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

@Injectable()
export class CrmProductsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, search?: string) {
    const products = await this.db
      .select()
      .from(crmProducts)
      .where(
        and(
          eq(crmProducts.orgId, orgId),
          isNull(crmProducts.deletedAt),
          search
            ? or(
                ilike(crmProducts.name, `%${escapeLike(search)}%`),
                ilike(crmProducts.sku, `%${escapeLike(search)}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(crmProducts.createdAt))
      .limit(100);
    return { products, total: products.length };
  }

  async create(orgId: string, input: CreateProductInput) {
    const [product] = await this.db
      .insert(crmProducts)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        sku: input.sku ?? null,
        category: input.category ?? null,
        unitPrice: Math.round(input.unitPrice),
        currency: input.currency ?? "INR",
        taxRate: Math.round(input.taxRate ?? 0),
        isActive: true,
      })
      .returning();
    return product;
  }

  async update(orgId: string, id: number, input: UpdateProductInput) {
    const [product] = await this.db
      .update(crmProducts)
      .set({
        ...input,
        ...(input.unitPrice !== undefined ? { unitPrice: Math.round(input.unitPrice) } : {}),
        ...(input.taxRate !== undefined ? { taxRate: Math.round(input.taxRate) } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(crmProducts.id, id),
          eq(crmProducts.orgId, orgId),
          isNull(crmProducts.deletedAt),
        ),
      )
      .returning();
    return product ?? null;
  }

  async remove(orgId: string, id: number) {
    const [deleted] = await this.db
      .update(crmProducts)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(crmProducts.id, id),
          eq(crmProducts.orgId, orgId),
          isNull(crmProducts.deletedAt),
        ),
      )
      .returning({ id: crmProducts.id });
    if (!deleted) throw new NotFoundException("Product not found");
    return { success: true as const };
  }
}
