import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, inArray } from "drizzle-orm";
import { targets, targetHistory, users, notifications } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { isBranchScoped, getBranchUserIds, type BranchContext } from "../leads/branch-filter";
import type { CreateInput, ListInput, UpdateInput } from "./dto/target.schemas";

export type TargetsForbidden = { error: "forbidden"; message: string; status: 403 | 400 };
export type TargetNotFound = { error: "not_found" };

export function isForbidden(value: unknown): value is TargetsForbidden {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "forbidden"
  );
}

export function isNotFound(value: unknown): value is TargetNotFound {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "not_found"
  );
}

interface CreateContext {
  role: string;
  callerId: string;
  permissions: string[];
  isOrgOwner: boolean;
  isPlatformAdmin: boolean;
}

interface ManageContext {
  role: string;
  callerId: string;
  branchId: number | null;
  permissions: string[];
  isOrgOwner: boolean;
  isPlatformAdmin: boolean;
}

@Injectable()
export class TargetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  list(orgId: string, filters: ListInput) {
    const key = `targets:list:${orgId}:${filters.userId ?? ""}:${filters.period ?? ""}:${filters.limit ?? ""}:${filters.offset ?? ""}`;
    return this.cache.cached(key, () => this.getTargets(orgId, filters), CACHE_TTL.SHORT);
  }

  private getTargets(orgId: string, filters: ListInput) {
    const f = [eq(targets.orgId, orgId)];
    if (filters.userId) f.push(eq(targets.userId, filters.userId));
    if (filters.period) f.push(eq(targets.period, filters.period));

    return this.db.query.targets.findMany({
      where: and(...f),
      with: { user: { columns: { id: true, name: true, image: true } } },
      orderBy: [desc(targets.createdAt)],
      limit: filters.limit ?? 50,
      offset: filters.offset ?? 0,
    });
  }

  getMyTargets(orgId: string, userId: string) {
    return this.db.query.targets.findMany({
      where: and(eq(targets.orgId, orgId), eq(targets.userId, userId)),
      orderBy: [desc(targets.startDate)],
    });
  }

  async getLeaderboard(orgId: string, metricType?: string) {
    const f = [eq(targets.orgId, orgId)];
    if (metricType) f.push(eq(targets.metricType, metricType));

    const allTargets = await this.db.query.targets.findMany({
      where: and(...f),
      with: { user: { columns: { id: true, name: true, image: true } } },
      orderBy: [desc(targets.currentValue)],
    });

    const userMap = new Map<
      string,
      { name: string; image: string | null; totalTarget: number; totalCurrent: number }
    >();

    for (const t of allTargets) {
      if (!t.user) continue;
      const existing = userMap.get(t.userId) || {
        name: t.user.name ?? "",
        image: t.user.image,
        totalTarget: 0,
        totalCurrent: 0,
      };
      existing.totalTarget += Number(t.targetValue);
      existing.totalCurrent += Number(t.currentValue ?? 0);
      userMap.set(t.userId, existing);
    }

    return Array.from(userMap.entries())
      .map(([userId, data]) => ({
        userId,
        ...data,
        progress:
          data.totalTarget > 0
            ? Math.round((data.totalCurrent / data.totalTarget) * 100)
            : 0,
      }))
      .sort((a, b) => b.progress - a.progress);
  }

  getHistory(orgId: string, targetId: number) {
    return this.db.query.targetHistory.findMany({
      where: and(eq(targetHistory.targetId, targetId), eq(targetHistory.orgId, orgId)),
      with: { changedBy: { columns: { id: true, name: true, image: true } } },
      orderBy: [desc(targetHistory.createdAt)],
    });
  }

  async create(orgId: string, ctx: CreateContext, input: CreateInput) {
    const resolvedUserIds = input.userIds?.length
      ? input.userIds
      : input.userId
        ? [input.userId]
        : [];

    if (resolvedUserIds.length === 0) {
      return { error: "forbidden", message: "At least one user is required", status: 400 } as TargetsForbidden;
    }

    if (!ctx.isOrgOwner && !ctx.isPlatformAdmin && !ctx.permissions.includes("crm:targets:manage") && ctx.role !== "BRANCH_MANAGER") {
      const targetUsers = await this.db
        .select({ id: users.id, reportingTo: users.reportingTo })
        .from(users)
        .where(inArray(users.id, resolvedUserIds));
      const allManaged = targetUsers.every((u) => u.reportingTo === ctx.callerId);
      if (!allManaged) {
        return {
          error: "forbidden",
          message: "You can only set targets for your direct reports",
          status: 403,
        } as TargetsForbidden;
      }
    }

    const created = await this.db
      .insert(targets)
      .values(
        resolvedUserIds.map((uid) => ({
          orgId,
          userId: uid,
          metricType: input.metricType,
          targetValue: input.targetValue,
          period: input.period,
          startDate: input.startDate,
          endDate: input.endDate,
          notes: input.notes ?? null,
          setById: ctx.callerId,
          branchId: input.branchId,
          parentTargetId: input.parentTargetId,
        })),
      )
      .returning();

    const metricLabel = input.metricType.replace(/_/g, " ");
    for (const uid of resolvedUserIds) {
      if (uid === ctx.callerId) continue;
      await this.db.insert(notifications).values({
        orgId,
        userId: uid,
        type: "INFO",
        title: "New target assigned",
        message: `You have a new ${input.period} target: ${input.targetValue} ${metricLabel}`,
        link: "/crm/targets",
      });
    }

    for (const t of created) {
      this.audit.log({
        action: "target.created",
        userId: ctx.callerId,
        orgId,
        targetId: String(t.id),
        targetType: "target",
        metadata: {
          assignedTo: t.userId,
          metricType: input.metricType,
          targetValue: input.targetValue,
          period: input.period,
        },
      });
    }

    await this.cache.invalidatePattern(`targets:list:${orgId}:*`);

    return created;
  }

  async update(orgId: string, ctx: ManageContext, targetId: number, input: UpdateInput) {
    const existing = await this.db.query.targets.findFirst({
      where: and(eq(targets.id, targetId), eq(targets.orgId, orgId)),
    });
    if (!existing) return { error: "not_found" } as TargetNotFound;

    const branchCtx: BranchContext = { role: ctx.role, branchId: ctx.branchId, userId: ctx.callerId };
    if (isBranchScoped(branchCtx)) {
      const branchUserIds = await getBranchUserIds(this.db, branchCtx);
      if (branchUserIds !== null && !branchUserIds.includes(existing.userId)) {
        return { error: "forbidden", message: "Target not in your branch", status: 403 } as TargetsForbidden;
      }
    }

    const canManage = await this.assertCanManage(ctx, ctx.callerId, [existing.userId]);
    if (!canManage) {
      return {
        error: "forbidden",
        message: "You can only set targets for your direct reports",
        status: 403,
      } as TargetsForbidden;
    }

    const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
    if (input.targetValue !== undefined && input.targetValue !== existing.targetValue) {
      changes.push({ field: "targetValue", oldValue: existing.targetValue, newValue: input.targetValue });
    }
    if (input.currentValue !== undefined && input.currentValue !== (existing.currentValue ?? "0")) {
      changes.push({ field: "currentValue", oldValue: existing.currentValue ?? "0", newValue: input.currentValue });
    }
    if (input.notes !== undefined && input.notes !== existing.notes) {
      changes.push({ field: "notes", oldValue: existing.notes, newValue: input.notes });
    }

    const updated = await this.db.transaction(async (tx) => {
      if (changes.length > 0) {
        await tx.insert(targetHistory).values(
          changes.map((c) => ({
            targetId,
            orgId,
            changedById: ctx.callerId,
            field: c.field,
            oldValue: c.oldValue,
            newValue: c.newValue,
          })),
        );
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (input.targetValue !== undefined) updateData.targetValue = input.targetValue;
      if (input.currentValue !== undefined) updateData.currentValue = input.currentValue;
      if (input.notes !== undefined) updateData.notes = input.notes;

      const [row] = await tx
        .update(targets)
        .set(updateData)
        .where(and(eq(targets.id, targetId), eq(targets.orgId, orgId)))
        .returning();
      return row;
    });

    if (!updated) return { error: "not_found" } as TargetNotFound;

    this.audit.log({
      action: "target.updated",
      userId: ctx.callerId,
      orgId,
      targetId: String(targetId),
      targetType: "target",
      metadata: { changes },
    });

    return updated;
  }

  async remove(orgId: string, ctx: ManageContext, targetId: number) {
    const existing = await this.db.query.targets.findFirst({
      where: and(eq(targets.id, targetId), eq(targets.orgId, orgId)),
    });
    if (!existing) return { error: "not_found" } as TargetNotFound;

    const branchCtx: BranchContext = { role: ctx.role, branchId: ctx.branchId, userId: ctx.callerId };
    if (isBranchScoped(branchCtx)) {
      const branchUserIds = await getBranchUserIds(this.db, branchCtx);
      if (branchUserIds !== null && !branchUserIds.includes(existing.userId)) {
        return { error: "forbidden", message: "Target not in your branch", status: 403 } as TargetsForbidden;
      }
    }

    const canManage = await this.assertCanManage(ctx, ctx.callerId, [existing.userId]);
    if (!canManage) {
      return {
        error: "forbidden",
        message: "You can only manage targets for your direct reports",
        status: 403,
      } as TargetsForbidden;
    }

    await this.db.delete(targets).where(and(eq(targets.id, targetId), eq(targets.orgId, orgId)));

    this.audit.log({
      action: "target.deleted",
      userId: ctx.callerId,
      orgId,
      targetId: String(targetId),
      targetType: "target",
      metadata: { assignedTo: existing.userId, metricType: existing.metricType },
    });

    return { success: true };
  }

  private async assertCanManage(
    caller: { isOrgOwner: boolean; isPlatformAdmin: boolean; permissions: string[] },
    callerId: string,
    userIds: string[],
  ) {
    if (caller.isOrgOwner || caller.isPlatformAdmin || caller.permissions.includes("crm:targets:manage")) return true;
    const targetUsers = await this.db
      .select({ id: users.id, reportingTo: users.reportingTo })
      .from(users)
      .where(inArray(users.id, userIds));
    return targetUsers.every((u) => u.reportingTo === callerId);
  }
}
