import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import {
  crmPricebooks,
  crmPricebookEntries,
  crmProducts,
  crmQuoteSettings,
  crmQuoteTemplates,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreatePricebookInput,
  UpdatePricebookInput,
  UpsertEntryInput,
  ResolvePriceQuery,
  QuoteSettingsInput,
  CreateTemplateInput,
  UpdateTemplateInput,
} from "./dto/pricebooks.schemas";

@Injectable()
export class CrmPricebooksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listPricebooks(orgId: string) {
    return this.db
      .select()
      .from(crmPricebooks)
      .where(and(eq(crmPricebooks.orgId, orgId), isNull(crmPricebooks.deletedAt)))
      .orderBy(desc(crmPricebooks.isDefault), desc(crmPricebooks.createdAt))
      .limit(100);
  }

  async createPricebook(orgId: string, input: CreatePricebookInput) {
    try {
      const [pb] = await this.db
        .insert(crmPricebooks)
        .values({
          orgId,
          name: input.name,
          description: input.description ?? null,
          currency: input.currency,
          isDefault: input.isDefault,
          isActive: input.isActive,
        })
        .returning();
      if (input.isDefault && pb) {
        await this.db
          .update(crmPricebooks)
          .set({ isDefault: false })
          .where(and(eq(crmPricebooks.orgId, orgId), sql`${crmPricebooks.id} != ${pb.id}`));
      }
      return pb;
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "23505") throw new ConflictException("A pricebook with this name already exists");
      throw e;
    }
  }

  async updatePricebook(orgId: string, pricebookId: string, input: UpdatePricebookInput) {
    const existing = await this.db.query.crmPricebooks.findFirst({
      where: and(eq(crmPricebooks.id, pricebookId), eq(crmPricebooks.orgId, orgId), isNull(crmPricebooks.deletedAt)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Pricebook not found");
    try {
      const [pb] = await this.db
        .update(crmPricebooks)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(crmPricebooks.id, pricebookId), eq(crmPricebooks.orgId, orgId)))
        .returning();
      if (input.isDefault) {
        await this.db
          .update(crmPricebooks)
          .set({ isDefault: false })
          .where(and(eq(crmPricebooks.orgId, orgId), sql`${crmPricebooks.id} != ${pricebookId}`));
      }
      return pb;
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "23505") throw new ConflictException("A pricebook with this name already exists");
      throw e;
    }
  }

  async deletePricebook(orgId: string, pricebookId: string) {
    const existing = await this.db.query.crmPricebooks.findFirst({
      where: and(eq(crmPricebooks.id, pricebookId), eq(crmPricebooks.orgId, orgId), isNull(crmPricebooks.deletedAt)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Pricebook not found");
    await this.db
      .update(crmPricebooks)
      .set({ deletedAt: new Date() })
      .where(and(eq(crmPricebooks.id, pricebookId), eq(crmPricebooks.orgId, orgId)));
    return { success: true as const };
  }

  async listEntries(orgId: string, pricebookId: string) {
    const pb = await this.db.query.crmPricebooks.findFirst({
      where: and(eq(crmPricebooks.id, pricebookId), eq(crmPricebooks.orgId, orgId), isNull(crmPricebooks.deletedAt)),
      columns: { id: true },
    });
    if (!pb) throw new NotFoundException("Pricebook not found");
    return this.db
      .select({
        id: crmPricebookEntries.id,
        productId: crmPricebookEntries.productId,
        unitPriceCents: crmPricebookEntries.unitPriceCents,
        minQuantity: crmPricebookEntries.minQuantity,
        productName: crmProducts.name,
        productSku: crmProducts.sku,
        productCurrency: crmProducts.currency,
      })
      .from(crmPricebookEntries)
      .leftJoin(crmProducts, eq(crmPricebookEntries.productId, crmProducts.id))
      .where(and(eq(crmPricebookEntries.pricebookId, pricebookId), eq(crmPricebookEntries.orgId, orgId)))
      .limit(100);
  }

  async upsertEntry(orgId: string, pricebookId: string, input: UpsertEntryInput) {
    const pb = await this.db.query.crmPricebooks.findFirst({
      where: and(eq(crmPricebooks.id, pricebookId), eq(crmPricebooks.orgId, orgId), isNull(crmPricebooks.deletedAt)),
      columns: { id: true },
    });
    if (!pb) throw new NotFoundException("Pricebook not found");
    try {
      const [entry] = await this.db
        .insert(crmPricebookEntries)
        .values({
          orgId,
          pricebookId,
          productId: input.productId,
          unitPriceCents: input.unitPriceCents,
          minQuantity: input.minQuantity,
        })
        .onConflictDoUpdate({
          target: [
            crmPricebookEntries.orgId,
            crmPricebookEntries.pricebookId,
            crmPricebookEntries.productId,
            crmPricebookEntries.minQuantity,
          ],
          set: { unitPriceCents: input.unitPriceCents, updatedAt: new Date() },
        })
        .returning();
      return entry;
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "23505") throw new ConflictException("Entry already exists");
      throw e;
    }
  }

  async deleteEntry(orgId: string, pricebookId: string, entryId: string) {
    const [deleted] = await this.db
      .delete(crmPricebookEntries)
      .where(
        and(
          eq(crmPricebookEntries.id, entryId),
          eq(crmPricebookEntries.pricebookId, pricebookId),
          eq(crmPricebookEntries.orgId, orgId),
        ),
      )
      .returning({ id: crmPricebookEntries.id });
    if (!deleted) throw new NotFoundException("Entry not found");
    return { success: true as const };
  }

  async resolvePrice(orgId: string, query: ResolvePriceQuery) {
    const qty = query.quantity;
    const pbId = query.pricebookId;

    if (pbId) {
      const entry = await this.db
        .select({ unitPriceCents: crmPricebookEntries.unitPriceCents, pricebookName: crmPricebooks.name })
        .from(crmPricebookEntries)
        .innerJoin(crmPricebooks, eq(crmPricebookEntries.pricebookId, crmPricebooks.id))
        .where(
          and(
            eq(crmPricebookEntries.pricebookId, pbId),
            eq(crmPricebookEntries.productId, query.productId),
            eq(crmPricebookEntries.orgId, orgId),
            lte(crmPricebookEntries.minQuantity, Math.max(1, Math.floor(qty))),
          ),
        )
        .orderBy(desc(crmPricebookEntries.minQuantity))
        .limit(1);
      if (entry[0]) {
        return {
          unitPriceCents: entry[0].unitPriceCents,
          source: "pricebook" as const,
          pricebookName: entry[0].pricebookName,
        };
      }
    }

    const defaultPb = await this.db.query.crmPricebooks.findFirst({
      where: and(
        eq(crmPricebooks.orgId, orgId),
        eq(crmPricebooks.isDefault, true),
        eq(crmPricebooks.isActive, true),
        isNull(crmPricebooks.deletedAt),
      ),
      columns: { id: true, name: true },
    });
    if (defaultPb) {
      const entry = await this.db
        .select({ unitPriceCents: crmPricebookEntries.unitPriceCents })
        .from(crmPricebookEntries)
        .where(
          and(
            eq(crmPricebookEntries.pricebookId, defaultPb.id),
            eq(crmPricebookEntries.productId, query.productId),
            eq(crmPricebookEntries.orgId, orgId),
            lte(crmPricebookEntries.minQuantity, Math.max(1, Math.floor(qty))),
          ),
        )
        .orderBy(desc(crmPricebookEntries.minQuantity))
        .limit(1);
      if (entry[0]) {
        return {
          unitPriceCents: entry[0].unitPriceCents,
          source: "pricebook" as const,
          pricebookName: defaultPb.name,
        };
      }
    }

    const product = await this.db.query.crmProducts.findFirst({
      where: and(eq(crmProducts.id, query.productId), eq(crmProducts.orgId, orgId)),
      columns: { unitPrice: true },
    });
    if (!product) throw new NotFoundException("Product not found");
    return { unitPriceCents: product.unitPrice, source: "product" as const, pricebookName: null };
  }

  async getQuoteSettings(orgId: string) {
    const settings = await this.db.query.crmQuoteSettings.findFirst({
      where: eq(crmQuoteSettings.orgId, orgId),
    });
    return (
      settings ?? {
        maxDiscountPercent: null,
        requirePricebookPrice: false,
        defaultExpiryDays: 30,
        allowPriceOverride: true,
      }
    );
  }

  async upsertQuoteSettings(orgId: string, input: QuoteSettingsInput) {
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (input.maxDiscountPercent !== undefined) setValues.maxDiscountPercent = input.maxDiscountPercent;
    if (input.requirePricebookPrice !== undefined) setValues.requirePricebookPrice = input.requirePricebookPrice;
    if (input.defaultExpiryDays !== undefined) setValues.defaultExpiryDays = input.defaultExpiryDays;
    if (input.allowPriceOverride !== undefined) setValues.allowPriceOverride = input.allowPriceOverride;

    const [settings] = await this.db
      .insert(crmQuoteSettings)
      .values({
        orgId,
        maxDiscountPercent: input.maxDiscountPercent ?? null,
        requirePricebookPrice: input.requirePricebookPrice ?? false,
        defaultExpiryDays: input.defaultExpiryDays ?? 30,
        allowPriceOverride: input.allowPriceOverride ?? true,
      })
      .onConflictDoUpdate({
        target: crmQuoteSettings.orgId,
        set: setValues,
      })
      .returning();
    return settings;
  }

  async listTemplates(orgId: string) {
    return this.db
      .select()
      .from(crmQuoteTemplates)
      .where(and(eq(crmQuoteTemplates.orgId, orgId), isNull(crmQuoteTemplates.deletedAt)))
      .orderBy(desc(crmQuoteTemplates.isDefault), desc(crmQuoteTemplates.createdAt))
      .limit(100);
  }

  async createTemplate(orgId: string, input: CreateTemplateInput) {
    try {
      const [tmpl] = await this.db
        .insert(crmQuoteTemplates)
        .values({
          orgId,
          name: input.name,
          isDefault: input.isDefault,
          branding: input.branding ?? null,
          terms: input.terms ?? null,
        })
        .returning();
      if (input.isDefault && tmpl) {
        await this.db
          .update(crmQuoteTemplates)
          .set({ isDefault: false })
          .where(and(eq(crmQuoteTemplates.orgId, orgId), sql`${crmQuoteTemplates.id} != ${tmpl.id}`));
      }
      return tmpl;
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "23505") throw new ConflictException("A template with this name already exists");
      throw e;
    }
  }

  async updateTemplate(orgId: string, templateId: string, input: UpdateTemplateInput) {
    const existing = await this.db.query.crmQuoteTemplates.findFirst({
      where: and(
        eq(crmQuoteTemplates.id, templateId),
        eq(crmQuoteTemplates.orgId, orgId),
        isNull(crmQuoteTemplates.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Template not found");
    try {
      const [tmpl] = await this.db
        .update(crmQuoteTemplates)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(crmQuoteTemplates.id, templateId), eq(crmQuoteTemplates.orgId, orgId)))
        .returning();
      if (input.isDefault) {
        await this.db
          .update(crmQuoteTemplates)
          .set({ isDefault: false })
          .where(and(eq(crmQuoteTemplates.orgId, orgId), sql`${crmQuoteTemplates.id} != ${templateId}`));
      }
      return tmpl;
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "23505") throw new ConflictException("A template with this name already exists");
      throw e;
    }
  }

  async deleteTemplate(orgId: string, templateId: string) {
    const existing = await this.db.query.crmQuoteTemplates.findFirst({
      where: and(
        eq(crmQuoteTemplates.id, templateId),
        eq(crmQuoteTemplates.orgId, orgId),
        isNull(crmQuoteTemplates.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Template not found");
    await this.db
      .update(crmQuoteTemplates)
      .set({ deletedAt: new Date() })
      .where(and(eq(crmQuoteTemplates.id, templateId), eq(crmQuoteTemplates.orgId, orgId)));
    return { success: true as const };
  }
}
