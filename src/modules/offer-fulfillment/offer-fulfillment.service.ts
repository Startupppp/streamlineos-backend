import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  offerFulfillmentComponents,
  crmProducts,
  invProductVariants,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { isUniqueViolation } from "../../common/db/postgres-error";
import type {
  CreateOfferFulfillmentInput,
  ListOfferFulfillmentQuery,
  UpdateOfferFulfillmentInput,
} from "./dto/offer-fulfillment.schemas";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBeforeValue } from "../../common/pagination/keyset";

type ComponentRow = typeof offerFulfillmentComponents.$inferSelect;
type ComponentPatch = Partial<typeof offerFulfillmentComponents.$inferInsert>;

@Injectable()
export class OfferFulfillmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async loadComponent(
    orgId: string,
    offerFulfillmentComponentId: number,
  ): Promise<ComponentRow> {
    const [row] = await this.db
      .select()
      .from(offerFulfillmentComponents)
      .where(
        and(
          eq(
            offerFulfillmentComponents.offerFulfillmentComponentId,
            offerFulfillmentComponentId,
          ),
          eq(offerFulfillmentComponents.orgId, orgId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Offer fulfillment mapping not found");
    return row;
  }

  private async assertOfferExists(orgId: string, crmOfferId: number): Promise<void> {
    const [row] = await this.db
      .select({ id: crmProducts.id })
      .from(crmProducts)
      .where(
        and(
          eq(crmProducts.id, crmOfferId),
          eq(crmProducts.orgId, orgId),
          isNull(crmProducts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("CRM offer not found in this organization");
  }

  private async assertSkuExists(orgId: string, invSkuId: number): Promise<void> {
    const [row] = await this.db
      .select({ id: invProductVariants.id })
      .from(invProductVariants)
      .where(
        and(eq(invProductVariants.id, invSkuId), eq(invProductVariants.orgId, orgId)),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Inventory SKU not found in this organization");
  }

  async listComponents(orgId: string, query: ListOfferFulfillmentQuery) {
    const { cursor, limit, crmOfferId, invSkuId, status } = query;
    const position = decodeCursor(cursor);
    const conditions = and(
      eq(offerFulfillmentComponents.orgId, orgId),
      crmOfferId ? eq(offerFulfillmentComponents.crmOfferId, crmOfferId) : undefined,
      invSkuId ? eq(offerFulfillmentComponents.invSkuId, invSkuId) : undefined,
      status ? eq(offerFulfillmentComponents.status, status) : undefined,
      position
        ? keysetBeforeValue(
            offerFulfillmentComponents.offerFulfillmentComponentId,
            offerFulfillmentComponents.offerFulfillmentComponentId,
            position,
          )
        : undefined,
    );
    const rows = await this.db
        .select()
        .from(offerFulfillmentComponents)
        .where(conditions)
        .orderBy(desc(offerFulfillmentComponents.offerFulfillmentComponentId))
        .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.offerFulfillmentComponentId),
      id: String(row.offerFulfillmentComponentId),
    }));
  }

  async getComponent(orgId: string, offerFulfillmentComponentId: number) {
    return this.loadComponent(orgId, offerFulfillmentComponentId);
  }

  async createComponent(
    orgId: string,
    userId: string,
    input: CreateOfferFulfillmentInput,
  ) {
    await Promise.all([
      this.assertOfferExists(orgId, input.crmOfferId),
      this.assertSkuExists(orgId, input.invSkuId),
    ]);
    const [row] = await this.db
      .insert(offerFulfillmentComponents)
      .values({
        orgId,
        crmOfferId: input.crmOfferId,
        crmOfferOrgId: orgId,
        invSkuId: input.invSkuId,
        invSkuOrgId: orgId,
        quantityPerUnit: input.quantityPerUnit.toString(),
        uom: input.uom ?? null,
        status: input.status,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        notes: input.notes ?? null,
        createdBy: userId,
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            "This CRM offer is already mapped to that Inventory SKU.",
          );
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create offer fulfillment mapping");
    this.audit.log({
      action: "offer_fulfillment.created",
      userId,
      orgId,
      resourceType: "offer_fulfillment_component",
      resourceId: String(row.offerFulfillmentComponentId),
      metadata: { crmOfferId: input.crmOfferId, invSkuId: input.invSkuId },
    });
    return row;
  }

  async updateComponent(
    orgId: string,
    userId: string,
    offerFulfillmentComponentId: number,
    input: UpdateOfferFulfillmentInput,
  ) {
    await this.loadComponent(orgId, offerFulfillmentComponentId);
    const patch: ComponentPatch = {};
    if (input.quantityPerUnit !== undefined)
      patch.quantityPerUnit = input.quantityPerUnit.toString();
    if (input.uom !== undefined) patch.uom = input.uom;
    if (input.status !== undefined) patch.status = input.status;
    if (input.effectiveFrom !== undefined) patch.effectiveFrom = input.effectiveFrom;
    if (input.effectiveTo !== undefined) patch.effectiveTo = input.effectiveTo;
    if (input.notes !== undefined) patch.notes = input.notes;
    const [updated] = await this.db
      .update(offerFulfillmentComponents)
      .set(patch)
      .where(
        and(
          eq(
            offerFulfillmentComponents.offerFulfillmentComponentId,
            offerFulfillmentComponentId,
          ),
          eq(offerFulfillmentComponents.orgId, orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Offer fulfillment mapping not found");
    this.audit.log({
      action: "offer_fulfillment.updated",
      userId,
      orgId,
      resourceType: "offer_fulfillment_component",
      resourceId: String(offerFulfillmentComponentId),
      metadata: { offerFulfillmentComponentId },
    });
    return updated;
  }

  async deleteComponent(
    orgId: string,
    userId: string,
    offerFulfillmentComponentId: number,
  ): Promise<{ success: true }> {
    await this.loadComponent(orgId, offerFulfillmentComponentId);
    await this.db
      .delete(offerFulfillmentComponents)
      .where(
        and(
          eq(
            offerFulfillmentComponents.offerFulfillmentComponentId,
            offerFulfillmentComponentId,
          ),
          eq(offerFulfillmentComponents.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "offer_fulfillment.deleted",
      userId,
      orgId,
      resourceType: "offer_fulfillment_component",
      resourceId: String(offerFulfillmentComponentId),
      metadata: { offerFulfillmentComponentId },
    });
    return { success: true };
  }
}
