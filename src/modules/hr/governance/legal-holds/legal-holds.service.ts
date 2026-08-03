import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrLegalHolds, hrLegalHoldItems } from "../../../../db/schema/hr/governance";
import { HrAuditService } from "../../core/hr-audit.service";
import type {
  CreateLegalHoldInput,
  UpdateLegalHoldInput,
  ListLegalHoldsInput,
  AttachHoldItemInput,
} from "./legal-holds.dto";

@Injectable()
export class LegalHoldsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async list(orgId: string, input: ListLegalHoldsInput) {
    const { page, limit, status, subjectUserId } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrLegalHolds.orgId, orgId), isNull(hrLegalHolds.deletedAt)];
    if (status) conditions.push(eq(hrLegalHolds.status, status));
    if (subjectUserId) conditions.push(eq(hrLegalHolds.subjectUserId, subjectUserId));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrLegalHolds)
        .where(where)
        .orderBy(desc(hrLegalHolds.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrLegalHolds).where(where),
    ]);

    return {
      data,
      total: totalResult[0]?.total ?? 0,
      page,
      limit,
    };
  }

  async getById(orgId: string, holdId: number) {
    const [row] = await this.db
      .select()
      .from(hrLegalHolds)
      .where(and(eq(hrLegalHolds.orgId, orgId), eq(hrLegalHolds.id, holdId), isNull(hrLegalHolds.deletedAt)))
      .limit(1);

    if (!row) throw new NotFoundException("Legal hold not found");
    return row;
  }

  async create(orgId: string, userId: string, input: CreateLegalHoldInput, ipAddress?: string) {
    const [hold] = await this.db
      .insert(hrLegalHolds)
      .values({
        orgId,
        subjectUserId: input.subjectUserId,
        reason: input.reason,
        status: "active",
        placedBy: userId,
        placedAt: new Date(),
        restrictedExport: input.restrictedExport ?? true,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_legal_hold",
      entityId: String(hold!.id),
      action: "legal_hold.placed",
      after: { subjectUserId: input.subjectUserId, reason: input.reason },
      ipAddress,
    });

    return hold!;
  }

  async update(orgId: string, holdId: number, userId: string, input: UpdateLegalHoldInput, ipAddress?: string) {
    const existing = await this.getById(orgId, holdId);

    const [updated] = await this.db
      .update(hrLegalHolds)
      .set({
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.restrictedExport !== undefined && { restrictedExport: input.restrictedExport }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrLegalHolds.orgId, orgId), eq(hrLegalHolds.id, holdId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_legal_hold",
      entityId: String(holdId),
      action: "legal_hold.updated",
      before: { reason: existing.reason },
      after: input,
      ipAddress,
    });

    return updated!;
  }

  async release(orgId: string, holdId: number, userId: string, ipAddress?: string) {
    const existing = await this.getById(orgId, holdId);

    if (existing.status === "released") {
      throw new BadRequestException("Legal hold is already released");
    }

    const [updated] = await this.db
      .update(hrLegalHolds)
      .set({ status: "released", releasedBy: userId, releasedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(hrLegalHolds.orgId, orgId), eq(hrLegalHolds.id, holdId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_legal_hold",
      entityId: String(holdId),
      action: "legal_hold.released",
      before: { status: "active" },
      after: { status: "released", releasedBy: userId },
      ipAddress,
    });

    return updated!;
  }

  async softDelete(orgId: string, holdId: number, userId: string, ipAddress?: string) {
    const existing = await this.getById(orgId, holdId);

    if (existing.status === "active") {
      throw new ForbiddenException("Cannot delete an active legal hold. Release it first.");
    }

    await this.db
      .update(hrLegalHolds)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrLegalHolds.orgId, orgId), eq(hrLegalHolds.id, holdId)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_legal_hold",
      entityId: String(holdId),
      action: "legal_hold.deleted",
      ipAddress,
    });
  }

  async listItems(orgId: string, holdId: number) {
    await this.getById(orgId, holdId);

    return this.db
      .select()
      .from(hrLegalHoldItems)
      .where(and(eq(hrLegalHoldItems.orgId, orgId), eq(hrLegalHoldItems.holdId, holdId)))
      .orderBy(desc(hrLegalHoldItems.createdAt));
  }

  async attachItem(orgId: string, holdId: number, userId: string, input: AttachHoldItemInput, ipAddress?: string) {
    await this.getById(orgId, holdId);

    const [item] = await this.db
      .insert(hrLegalHoldItems)
      .values({
        orgId,
        holdId,
        itemType: input.itemType,
        itemRef: input.itemRef,
        locked: input.locked ?? true,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_legal_hold",
      entityId: String(holdId),
      action: "legal_hold.item_attached",
      after: { itemType: input.itemType, itemRef: input.itemRef },
      ipAddress,
    });

    return item!;
  }

  async detachItem(orgId: string, holdId: number, itemId: number, userId: string, ipAddress?: string) {
    await this.getById(orgId, holdId);

    const [existing] = await this.db
      .select()
      .from(hrLegalHoldItems)
      .where(and(eq(hrLegalHoldItems.orgId, orgId), eq(hrLegalHoldItems.holdId, holdId), eq(hrLegalHoldItems.id, itemId)))
      .limit(1);

    if (!existing) throw new NotFoundException("Hold item not found");

    await this.db
      .delete(hrLegalHoldItems)
      .where(and(eq(hrLegalHoldItems.orgId, orgId), eq(hrLegalHoldItems.id, itemId)));

    await this.audit.log({
      orgId,
      actorId: userId,
      entityType: "hr_legal_hold",
      entityId: String(holdId),
      action: "legal_hold.item_detached",
      after: { itemId, itemRef: existing.itemRef },
      ipAddress,
    });
  }
}
