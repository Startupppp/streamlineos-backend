import { BadRequestException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { hrPositionStatuses, hrPositionTransitions } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";

export type PositionTransitionRow = {
  fromStatusId: number | null;
  toStatusId: number;
  requiresApproval: boolean;
  requiredFields: string[] | null;
  allowedRoles: string[] | null;
};

export type PositionStatusRow = {
  id: number;
  name: string;
};

export type PrefetchedPositionWorkflow = {
  transitions: PositionTransitionRow[];
  statuses: PositionStatusRow[];
};

export type PositionTransitionContext = {
  isOrgOwner: boolean;
  orgRole?: string | null;
  positionFields?: {
    incumbentUserId: string | null | undefined;
    departmentId: string | null | undefined;
    budgetedCostCents: number | null | undefined;
    jobLevelId: number | null | undefined;
  };
};

async function fetchTransitionsAndStatuses(
  db: Db,
  orgId: string,
): Promise<PrefetchedPositionWorkflow> {
  const [transitions, statuses] = await Promise.all([
    db
      .select({
        fromStatusId: hrPositionTransitions.fromStatusId,
        toStatusId: hrPositionTransitions.toStatusId,
        requiresApproval: hrPositionTransitions.requiresApproval,
        requiredFields: hrPositionTransitions.requiredFields,
        allowedRoles: hrPositionTransitions.allowedRoles,
      })
      .from(hrPositionTransitions)
      .where(
        and(
          eq(hrPositionTransitions.orgId, orgId),
          isNull(hrPositionTransitions.deletedAt),
        ),
      )
      .limit(500),
    db
      .select({ id: hrPositionStatuses.id, name: hrPositionStatuses.name })
      .from(hrPositionStatuses)
      .where(eq(hrPositionStatuses.orgId, orgId))
      .limit(100),
  ]);
  return { transitions, statuses };
}

export async function assertPositionTransitionAllowed(
  db: Db,
  orgId: string,
  fromText: string,
  toText: string,
  context: PositionTransitionContext,
  prefetched?: PrefetchedPositionWorkflow,
): Promise<void> {
  const { transitions, statuses } =
    prefetched ?? (await fetchTransitionsAndStatuses(db, orgId));

  if (transitions.length === 0) return;

  const nameToId = new Map(statuses.map((s) => [s.name, s.id]));

  const resolvedFrom = nameToId.get(fromText);
  const resolvedTo = nameToId.get(toText);

  if (resolvedFrom === undefined || resolvedTo === undefined) return;

  const matching = transitions.filter(
    (t) =>
      t.toStatusId === resolvedTo &&
      (t.fromStatusId === resolvedFrom || t.fromStatusId === null),
  );

  if (matching.length === 0) {
    throw new BadRequestException(
      `Transition from '${fromText}' to '${toText}' is not allowed by this organisation's position workflow.`,
    );
  }

  const bypass = context.isOrgOwner;

  for (const t of matching) {
    if (t.requiresApproval && !bypass) {
      throw new BadRequestException(
        `This transition requires approval before moving to '${toText}'. Submit an approval request first.`,
      );
    }

    if (
      Array.isArray(t.allowedRoles) &&
      t.allowedRoles.length > 0 &&
      !bypass
    ) {
      const role = context.orgRole ?? null;
      if (!role || !t.allowedRoles.includes(role)) {
        throw new BadRequestException(
          `Your role ('${role ?? "unknown"}') is not permitted to make this transition.`,
        );
      }
    }

    if (
      Array.isArray(t.requiredFields) &&
      t.requiredFields.length > 0 &&
      context.positionFields !== undefined
    ) {
      const fields = context.positionFields;
      const missing: string[] = [];
      for (const field of t.requiredFields) {
        if (field === "incumbentUserId" && !fields.incumbentUserId)
          missing.push(field);
        else if (field === "departmentId" && !fields.departmentId)
          missing.push(field);
        else if (
          field === "budgetedCostCents" &&
          fields.budgetedCostCents == null
        )
          missing.push(field);
        else if (field === "jobLevelId" && fields.jobLevelId == null)
          missing.push(field);
      }
      if (missing.length > 0) {
        throw new BadRequestException(
          `Cannot move to '${toText}': the following fields are required: ${missing.join(", ")}.`,
        );
      }
    }
  }
}
