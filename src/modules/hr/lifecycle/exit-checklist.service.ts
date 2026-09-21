import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { exitChecklists, hrTemplates, organizationMembers, resignations, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { ApprovalAuthorityService } from "../../directory/approval-authority.service";
import { HrAuditService } from "../core/hr-audit.service";
import {
  EXIT_CHECKLIST_KINDS,
  EXIT_CHECKLIST_QUEUES,
  isExitChecklistQueue,
  type ExitChecklist,
  type ExitChecklistItem,
  type ExitChecklistItemUpdateInput,
  type ExitChecklistOwner,
  type ExitChecklistQueue,
  type ExitChecklistStatus,
} from "./dto/exit-checklist.schemas";
import {
  customItemKey,
  exitAnchorDay,
  isoDayOf,
  kindOfItemKey,
  planExitChecklist,
  type ExitChecklistAnchor,
  type ExitChecklistOwnerRule,
  type OffboardingTemplateItem,
} from "./exit-checklist.defaults";

export interface ExitChecklistActor {
  userId: string;
  membershipId: number | null;
  isAdmin: boolean;
}

interface ResignationFacts extends ExitChecklistAnchor {
  id: number;
  userId: string;
  userMembershipId: number | null;
  status: string;
}

interface MemberOwner {
  userId: string;
  membershipId: number;
}

type OwnerColumns = Pick<typeof exitChecklists.$inferInsert, "assignedTo" | "assignedToMembershipId" | "ownerQueue">;

interface ChecklistRow {
  id: number;
  itemKey: string;
  item: string;
  status: ExitChecklistStatus;
  dueDate: string | null;
  assignedToMembershipId: number | null;
  ownerQueue: string | null;
  completedAt: Date | null;
  completedByMembershipId: number | null;
  evidence: string | null;
  notes: string | null;
  updatedAt: Date;
  assigneeUserId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  completerName: string | null;
}

export const EXIT_CHECKLIST_ITEM_CAP = 100;
export const EXIT_CHECKLIST_ROUTED_RESIGNATION_CAP = 100;
export const HR_EXITS_QUEUE: ExitChecklistQueue = "hr:exit:manage";
export const MANAGER_HANDOVER_PERMISSION = "hr:exit:view";

const KIND_ORDER = new Map<string, number>(EXIT_CHECKLIST_KINDS.map((kind, index) => [kind, index]));

const assignee = alias(organizationMembers, "exit_checklist_assignee");
const assigneeUser = alias(users, "exit_checklist_assignee_user");
const completer = alias(organizationMembers, "exit_checklist_completer");
const completerUser = alias(users, "exit_checklist_completer_user");

function queueColumns(permission: ExitChecklistQueue): OwnerColumns {
  return { assignedTo: null, assignedToMembershipId: null, ownerQueue: permission };
}

function memberColumns(member: MemberOwner): OwnerColumns {
  return { assignedTo: member.userId, assignedToMembershipId: member.membershipId, ownerQueue: null };
}

function isTemplateItem(value: unknown): value is OffboardingTemplateItem {
  return typeof value === "object" && value !== null && "title" in value && typeof value.title === "string";
}

@Injectable()
export class ExitChecklistService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly approvals: ApprovalAuthorityService,
    private readonly access: AccessService,
    private readonly hrAudit: HrAuditService,
  ) {}

  async seedForResignation(orgId: string, resignationId: number): Promise<{ created: number }> {
    const resignation = await this.resignationFacts(orgId, resignationId);
    const planned = planExitChecklist(resignation, await this.activeTemplateItems(orgId));
    const manager = planned.some((item) => item.owner.type === "manager")
      ? await this.managerOwner(orgId, resignation.userId)
      : null;
    const inserted = await this.db
      .insert(exitChecklists)
      .values(
        planned.map((item) => ({
          orgId,
          resignationId,
          itemKey: item.itemKey,
          item: item.title,
          dueDate: item.dueDate,
          status: "PENDING" as const,
          ...this.ownerColumns(item.owner, manager, resignation),
        })),
      )
      .onConflictDoNothing({ target: [exitChecklists.orgId, exitChecklists.resignationId, exitChecklists.itemKey] })
      .returning({ id: exitChecklists.id });
    return { created: inserted.length };
  }

  async addCustomItems(orgId: string, resignationId: number, titles: readonly string[]): Promise<{ created: number }> {
    if (titles.length === 0) return { created: 0 };
    const resignation = await this.resignationFacts(orgId, resignationId);
    const dueDate = exitAnchorDay(resignation);
    const inserted = await this.db
      .insert(exitChecklists)
      .values(
        titles.map((title) => ({
          orgId,
          resignationId,
          itemKey: customItemKey(randomUUID().replace(/-/g, "").slice(0, 8)),
          item: title.trim(),
          dueDate,
          status: "PENDING" as const,
          ...queueColumns(HR_EXITS_QUEUE),
        })),
      )
      .returning({ id: exitChecklists.id });
    return { created: inserted.length };
  }

  async listForResignation(orgId: string, resignationId: number, viewer: ExitChecklistActor): Promise<ExitChecklist> {
    const rows = await this.readRows(orgId, resignationId);
    const held = viewer.isAdmin ? null : await this.access.resolveUserPermissions(orgId, viewer.userId);
    const today = isoDayOf(new Date());
    const items = rows
      .map((row) => this.toItem(row, viewer, held))
      .sort((left, right) => (KIND_ORDER.get(left.itemKey) ?? EXIT_CHECKLIST_KINDS.length) - (KIND_ORDER.get(right.itemKey) ?? EXIT_CHECKLIST_KINDS.length) || left.id - right.id);
    return {
      items,
      summary: {
        total: items.length,
        open: items.filter((item) => item.status === "PENDING").length,
        done: items.filter((item) => item.status === "DONE").length,
        waived: items.filter((item) => item.status === "WAIVED").length,
        overdue: items.filter((item) => item.status === "PENDING" && item.dueDate !== null && item.dueDate < today).length,
      },
    };
  }

  async openItemCount(orgId: string, resignationId: number): Promise<number> {
    const [row] = await this.db
      .select({ open: sql<number>`count(*)::int` })
      .from(exitChecklists)
      .where(and(eq(exitChecklists.orgId, orgId), eq(exitChecklists.resignationId, resignationId), eq(exitChecklists.status, "PENDING")));
    return row?.open ?? 0;
  }

  async resignationIdsRoutedTo(orgId: string, membershipId: number): Promise<number[]> {
    const rows = await this.db
      .selectDistinct({ resignationId: exitChecklists.resignationId })
      .from(exitChecklists)
      .where(and(eq(exitChecklists.orgId, orgId), eq(exitChecklists.assignedToMembershipId, membershipId)))
      .orderBy(desc(exitChecklists.resignationId))
      .limit(EXIT_CHECKLIST_ROUTED_RESIGNATION_CAP);
    return rows.map((row) => row.resignationId);
  }

  async updateItem(
    orgId: string,
    actor: ExitChecklistActor,
    resignationId: number,
    itemKey: string,
    input: ExitChecklistItemUpdateInput,
  ): Promise<ExitChecklistItem> {
    const resignation = await this.resignationFacts(orgId, resignationId);
    const [row] = await this.readRows(orgId, resignationId, itemKey);
    if (!row) throw new NotFoundException("Checklist item not found.");
    if (actor.membershipId === null) throw new ForbiddenException("Organization membership required.");
    if (resignation.status === "COMPLETED") throw new BadRequestException("The exit is complete, so its checklist is closed.");

    const held = actor.isAdmin ? null : await this.access.resolveUserPermissions(orgId, actor.userId);
    if (!this.canUpdate(row, actor, held)) {
      throw new ForbiddenException("Only the item's owner or an exit administrator can update it.");
    }
    const reassigns = input.ownerMembershipId !== undefined || input.ownerQueue !== undefined || input.dueDate !== undefined;
    if (reassigns && !actor.isAdmin) {
      throw new ForbiddenException("Only an exit administrator can reassign an item or change its due date.");
    }

    const member = input.ownerMembershipId === undefined ? null : await this.activeMember(orgId, input.ownerMembershipId);
    const closing = input.status !== undefined && input.status !== "PENDING";
    const reopening = input.status === "PENDING";
    const changes: Partial<typeof exitChecklists.$inferInsert> = {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.evidence !== undefined && { evidence: input.evidence }),
      ...(input.notes !== undefined && { notes: input.notes || null }),
      ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
      ...(member && memberColumns(member)),
      ...(input.ownerQueue !== undefined && queueColumns(input.ownerQueue)),
      ...(closing && { completedAt: new Date(), completedByMembershipId: actor.membershipId }),
      ...(reopening && { completedAt: null, completedByMembershipId: null }),
    };

    await this.db
      .update(exitChecklists)
      .set(changes)
      .where(and(eq(exitChecklists.id, row.id), eq(exitChecklists.orgId, orgId)));
    await this.hrAudit.log({
      orgId,
      actorId: actor.userId,
      actorMembershipId: actor.membershipId,
      entityType: "exit_checklists",
      entityId: String(row.id),
      action: "exit_checklist_item_updated",
      before: {
        resignationId,
        itemKey,
        status: row.status,
        dueDate: row.dueDate,
        assignedToMembershipId: row.assignedToMembershipId,
        ownerQueue: row.ownerQueue,
        evidence: row.evidence,
      },
      after: { resignationId, itemKey, ...changes },
    });

    const [updated] = await this.readRows(orgId, resignationId, itemKey);
    if (!updated) throw new NotFoundException("Checklist item not found.");
    return this.toItem(updated, actor, held);
  }

  private async resignationFacts(orgId: string, resignationId: number): Promise<ResignationFacts> {
    const [row] = await this.db
      .select({
        id: resignations.id,
        userId: resignations.userId,
        userMembershipId: resignations.userMembershipId,
        status: resignations.status,
        lastWorkingDate: resignations.lastWorkingDate,
        noticePeriodDays: resignations.noticePeriodDays,
        createdAt: resignations.createdAt,
      })
      .from(resignations)
      .where(and(eq(resignations.id, resignationId), eq(resignations.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Resignation not found.");
    return row;
  }

  private async activeTemplateItems(orgId: string): Promise<OffboardingTemplateItem[]> {
    const template = await this.db.query.hrTemplates.findFirst({
      where: and(
        eq(hrTemplates.orgId, orgId),
        eq(hrTemplates.kind, "offboarding_checklist"),
        eq(hrTemplates.status, "active"),
        isNull(hrTemplates.deletedAt),
      ),
      orderBy: [desc(hrTemplates.updatedAt)],
      columns: { content: true },
    });
    const items: unknown = template?.content["items"];
    return Array.isArray(items) ? items.filter(isTemplateItem) : [];
  }

  private async managerOwner(orgId: string, leaverUserId: string): Promise<MemberOwner | null> {
    const route = await this.approvals.resolve(orgId, leaverUserId, "exit", {
      permission: MANAGER_HANDOVER_PERMISSION,
      queuePermission: HR_EXITS_QUEUE,
    });
    const person = route.approver ?? route.assignedTo;
    return person ? { userId: person.userId, membershipId: person.membershipId } : null;
  }

  private ownerColumns(rule: ExitChecklistOwnerRule, manager: MemberOwner | null, resignation: ResignationFacts): OwnerColumns {
    if (rule.type === "queue") return queueColumns(rule.permission);
    if (rule.type === "manager") return manager ? memberColumns(manager) : queueColumns(HR_EXITS_QUEUE);
    return resignation.userMembershipId === null
      ? queueColumns(HR_EXITS_QUEUE)
      : memberColumns({ userId: resignation.userId, membershipId: resignation.userMembershipId });
  }

  private async activeMember(orgId: string, membershipId: number): Promise<MemberOwner> {
    const [row] = await this.db
      .select({ membershipId: organizationMembers.id, userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, membershipId), eq(organizationMembers.status, "ACTIVE")))
      .limit(1);
    if (!row) throw new BadRequestException("The new owner must be an active member of this organization.");
    return row;
  }

  private async readRows(orgId: string, resignationId: number, itemKey?: string): Promise<ChecklistRow[]> {
    const conditions = [eq(exitChecklists.orgId, orgId), eq(exitChecklists.resignationId, resignationId)];
    if (itemKey !== undefined) conditions.push(eq(exitChecklists.itemKey, itemKey));
    return this.db
      .select({
        id: exitChecklists.id,
        itemKey: exitChecklists.itemKey,
        item: exitChecklists.item,
        status: exitChecklists.status,
        dueDate: exitChecklists.dueDate,
        assignedToMembershipId: exitChecklists.assignedToMembershipId,
        ownerQueue: exitChecklists.ownerQueue,
        completedAt: exitChecklists.completedAt,
        completedByMembershipId: exitChecklists.completedByMembershipId,
        evidence: exitChecklists.evidence,
        notes: exitChecklists.notes,
        updatedAt: exitChecklists.updatedAt,
        assigneeUserId: assignee.userId,
        assigneeName: assigneeUser.name,
        assigneeEmail: assigneeUser.email,
        completerName: completerUser.name,
      })
      .from(exitChecklists)
      .leftJoin(assignee, and(eq(assignee.id, exitChecklists.assignedToMembershipId), eq(assignee.orgId, exitChecklists.orgId)))
      .leftJoin(assigneeUser, eq(assigneeUser.id, assignee.userId))
      .leftJoin(completer, and(eq(completer.id, exitChecklists.completedByMembershipId), eq(completer.orgId, exitChecklists.orgId)))
      .leftJoin(completerUser, eq(completerUser.id, completer.userId))
      .where(and(...conditions))
      .orderBy(asc(exitChecklists.id))
      .limit(itemKey === undefined ? EXIT_CHECKLIST_ITEM_CAP : 1);
  }

  private ownerOf(row: ChecklistRow): ExitChecklistOwner {
    if (row.assignedToMembershipId !== null && row.assigneeUserId !== null && row.assigneeEmail !== null) {
      return {
        type: "member",
        membershipId: row.assignedToMembershipId,
        userId: row.assigneeUserId,
        name: row.assigneeName,
        email: row.assigneeEmail,
      };
    }
    const permission = row.ownerQueue !== null && isExitChecklistQueue(row.ownerQueue) ? row.ownerQueue : HR_EXITS_QUEUE;
    return { type: "queue", permission, label: EXIT_CHECKLIST_QUEUES[permission] };
  }

  private canUpdate(row: ChecklistRow, viewer: ExitChecklistActor, held: ReadonlyMap<string, DataScope> | null): boolean {
    if (viewer.isAdmin) return true;
    if (viewer.membershipId !== null && row.assignedToMembershipId === viewer.membershipId) return true;
    const owner = this.ownerOf(row);
    if (owner.type !== "queue" || held === null) return false;
    const scope = held.get(owner.permission);
    return scope !== undefined && scope !== "none";
  }

  private toItem(row: ChecklistRow, viewer: ExitChecklistActor, held: ReadonlyMap<string, DataScope> | null): ExitChecklistItem {
    return {
      id: row.id,
      itemKey: row.itemKey,
      kind: kindOfItemKey(row.itemKey),
      title: row.item,
      status: row.status,
      dueDate: row.dueDate,
      owner: this.ownerOf(row),
      completedAt: row.completedAt,
      completedBy: row.completedByMembershipId === null ? null : { membershipId: row.completedByMembershipId, name: row.completerName },
      evidence: row.evidence,
      notes: row.notes,
      updatedAt: row.updatedAt,
      viewerCanUpdate: this.canUpdate(row, viewer, held),
    };
  }
}
