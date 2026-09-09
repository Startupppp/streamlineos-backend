import {
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import {
  and,
  count,
  eq,
  isNull,
  ne,
} from "drizzle-orm";
import {
  projectStatuses,
  tickets,
  workflowTransitions,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";

export type WorkflowTransitionRow = {
  fromStatusId: number | null;
  toStatusId: number;
  requiresApproval: boolean | null;
  requiredFields: string[] | null;
  allowedRoles: string[] | null;
};

export type WorkflowStatusRow = {
  id: number;
  name: string;
  wipLimit: number | null;
};

export type PrefetchedWorkflow = {
  transitions: WorkflowTransitionRow[];
  statuses: WorkflowStatusRow[];
  ticketFields?: Map<number, Pick<typeof tickets.$inferSelect, "assigneeMembershipId" | "dueDate" | "priority" | "points" | "epicId" | "sprintId">>;
  wipAlreadyChecked?: boolean;
};

export async function fetchTransitionsAndStatuses(
  db: Db,
  orgId: string,
  projectId: number,
): Promise<PrefetchedWorkflow> {
    const [transitions, statuses] = await Promise.all([
      db
        .select({
          fromStatusId: workflowTransitions.fromStatusId,
          toStatusId: workflowTransitions.toStatusId,
          requiresApproval: workflowTransitions.requiresApproval,
          requiredFields: workflowTransitions.requiredFields,
          allowedRoles: workflowTransitions.allowedRoles,
        })
        .from(workflowTransitions)
        .where(
          and(
            eq(workflowTransitions.orgId, orgId),
            eq(workflowTransitions.projectId, projectId),
            isNull(workflowTransitions.deletedAt),
          ),
        ),
      db
        .select({
          id: projectStatuses.id,
          name: projectStatuses.name,
          wipLimit: projectStatuses.wipLimit,
        })
        .from(projectStatuses)
        .where(
          and(
            eq(projectStatuses.orgId, orgId),
            eq(projectStatuses.projectId, projectId),
          ),
        ),
    ]);
    return { transitions, statuses };
}

export async function assertTransitionAllowed(
  db: Db,
  orgId: string,
  projectId: number,
  fromText: string,
  toText: string,
  context: {
    userId: string;
    userProjectRole: string | null;
    isOrgOwner: boolean;
    ticketId: number;
  },
  prefetched?: PrefetchedWorkflow,
): Promise<void> {
  const { transitions, statuses } =
    prefetched ?? (await fetchTransitionsAndStatuses(db, orgId, projectId));

  if (transitions.length === 0) return;

  const nameToId = new Map(statuses.map((s) => [s.name, s.id]));
  const idToStatus = new Map(statuses.map((s) => [s.id, s]));

  const resolvedFrom = nameToId.get(fromText);
  const resolvedTo = nameToId.get(toText);

  if (resolvedFrom === undefined || resolvedTo === undefined) return;

  const matchingTransitions = transitions.filter(
    (t) =>
      t.toStatusId === resolvedTo &&
      (t.fromStatusId === resolvedFrom || t.fromStatusId === null),
  );

  if (matchingTransitions.length === 0) {
    throw new BadRequestException(
      `Transition from '${fromText}' to '${toText}' is not allowed by this project's workflow.`,
    );
  }

  const bypassPrivilege = context.isOrgOwner;

  const readTicketRequiredFields = () =>
    db
      .select({
        assigneeMembershipId: tickets.assigneeMembershipId,
        dueDate: tickets.dueDate,
        priority: tickets.priority,
        points: tickets.points,
        epicId: tickets.epicId,
        sprintId: tickets.sprintId,
      })
      .from(tickets)
      .where(and(eq(tickets.id, context.ticketId), eq(tickets.orgId, orgId)))
      .limit(1);

  let ticketRows: Awaited<ReturnType<typeof readTicketRequiredFields>> | undefined;

  for (const transition of matchingTransitions) {
    if (transition.requiresApproval && !bypassPrivilege) {
      throw new BadRequestException(
        `This transition requires approval before moving to '${toText}'. Submit an approval request first.`,
      );
    }

    if (
      Array.isArray(transition.allowedRoles) &&
      transition.allowedRoles.length > 0 &&
      !bypassPrivilege
    ) {
      if (
        !context.userProjectRole ||
        !transition.allowedRoles.includes(context.userProjectRole)
      ) {
        throw new BadRequestException(
          `Your project role ('${context.userProjectRole ?? "unknown"}') is not allowed to make this transition.`,
        );
      }
    }

    if (
      Array.isArray(transition.requiredFields) &&
      transition.requiredFields.length > 0
    ) {
      if (ticketRows === undefined) {
        const prefetchedTicket = prefetched?.ticketFields?.get(context.ticketId);
        ticketRows = prefetchedTicket ? [prefetchedTicket] : await readTicketRequiredFields();
      }

      if (ticketRows.length > 0) {
        const row = ticketRows[0];
        const missing: string[] = [];
        for (const field of transition.requiredFields) {
          if (field === "assigneeId" && !row.assigneeMembershipId) missing.push(field);
          else if (field === "dueDate" && !row.dueDate) missing.push(field);
          else if (field === "priority" && !row.priority) missing.push(field);
          else if (
            field === "points" &&
            (row.points === null || row.points === undefined)
          )
            missing.push(field);
          else if (field === "epicId" && !row.epicId) missing.push(field);
          else if (field === "sprintId" && !row.sprintId) missing.push(field);
        }
        if (missing.length > 0) {
          throw new BadRequestException(
            `Cannot move to '${toText}': the following fields are required: ${missing.join(", ")}.`,
          );
        }
      }
    }
  }

  const toStatus = idToStatus.get(resolvedTo);
  if (toStatus?.wipLimit != null && !prefetched?.wipAlreadyChecked) {
    await assertWipLimit(
      db,
      orgId,
      projectId,
      toText,
      toStatus.wipLimit,
      context.ticketId,
    );
  }
}

export async function assertWipLimit(
  db: Db,
  orgId: string,
  projectId: number,
  statusName: string,
  wipLimit: number,
  excludeTicketId?: number,
): Promise<void> {
  const conditions = [
    eq(tickets.orgId, orgId),
    eq(tickets.projectId, projectId),
    eq(tickets.status, statusName),
    isNull(tickets.deletedAt),
  ];
  if (excludeTicketId !== undefined)
    conditions.push(ne(tickets.id, excludeTicketId));
  const [countResult] = await db
    .select({ cnt: count() })
    .from(tickets)
    .where(and(...conditions));
  const currentCount = Number(countResult?.cnt ?? 0);
  if (currentCount >= wipLimit) {
    throw new ConflictException(
      `Column '${statusName}' is at its WIP limit of ${wipLimit}. Move or complete an existing ticket first.`,
    );
  }
}

export async function enforceWipLimitForStatus(
  db: Db,
  orgId: string,
  projectId: number,
  statusName: string,
  excludeTicketId: number,
): Promise<void> {
  const rows = await db
    .select({
      wipLimit: projectStatuses.wipLimit,
      name: projectStatuses.name,
    })
    .from(projectStatuses)
    .where(
      and(
        eq(projectStatuses.orgId, orgId),
        eq(projectStatuses.projectId, projectId),
        eq(projectStatuses.name, statusName),
      ),
    )
    .limit(1);
  const wipLimit = rows[0]?.wipLimit;
  if (wipLimit == null) return;
  await assertWipLimit(
    db,
    orgId,
    projectId,
    statusName,
    wipLimit,
    excludeTicketId,
  );
}
