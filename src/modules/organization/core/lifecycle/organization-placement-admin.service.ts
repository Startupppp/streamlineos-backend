import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.types";
import { AuditService } from "../../../../common/audit/audit.service";
import type { PlacementStatus } from "../../../../common/region/placement";
import {
  getRegionRegistry,
  hasRegionRegistry,
} from "../../../../common/region/region-registry";
import {
  fetchPlacementRow,
  transitionPlacementStatus,
  type PlacementTransitionRow,
} from "../../../../common/region/placement-lookup";

export const PLACEMENT_TRANSITIONS: ReadonlyMap<
  PlacementStatus,
  ReadonlySet<PlacementStatus>
> = new Map([
  ["ACTIVE", new Set<PlacementStatus>(["MOVING", "READ_ONLY", "FAILED"])],
  ["MOVING", new Set<PlacementStatus>(["ACTIVE", "READ_ONLY", "FAILED"])],
  ["READ_ONLY", new Set<PlacementStatus>(["ACTIVE", "FAILED"])],
  ["FAILED", new Set<PlacementStatus>(["ACTIVE"])],
]);

export function isTransitionAllowed(
  from: PlacementStatus,
  to: PlacementStatus,
): boolean {
  return PLACEMENT_TRANSITIONS.get(from)?.has(to) ?? false;
}

@Injectable()
export class OrganizationPlacementAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async current(orgId: string): Promise<PlacementTransitionRow> {
    const row = await fetchPlacementRow(this.db, orgId);
    if (!row) throw new NotFoundException(`No placement row for organisation ${orgId}`);
    return row;
  }

  async markMoving(orgId: string, actorUserId: string): Promise<PlacementTransitionRow> {
    return this.applyTransition(orgId, actorUserId, "MOVING");
  }

  async markReadOnly(orgId: string, actorUserId: string): Promise<PlacementTransitionRow> {
    return this.applyTransition(orgId, actorUserId, "READ_ONLY");
  }

  async markFailed(
    orgId: string,
    actorUserId: string,
    reason: string,
  ): Promise<PlacementTransitionRow> {
    return this.applyTransition(orgId, actorUserId, "FAILED", reason);
  }

  async markActive(orgId: string, actorUserId: string): Promise<PlacementTransitionRow> {
    return this.applyTransition(orgId, actorUserId, "ACTIVE");
  }

  private async applyTransition(
    orgId: string,
    actorUserId: string,
    to: PlacementStatus,
    reason?: string,
  ): Promise<PlacementTransitionRow> {
    const current = await fetchPlacementRow(this.db, orgId);
    if (!current) throw new NotFoundException(`No placement row for organisation ${orgId}`);

    const from = current.status;
    if (!isTransitionAllowed(from, to))
      throw new ConflictException(
        `Placement transition ${from} → ${to} is not allowed`,
      );

    const updated = await transitionPlacementStatus(this.db, {
      orgId,
      from,
      to,
      currentVersion: current.placementVersion,
    });

    if (!updated)
      throw new ConflictException(
        `Placement transition ${from} → ${to} was not applied — a concurrent change modified the row`,
      );

    if (hasRegionRegistry())
      getRegionRegistry().forgetVersionsBelow(orgId, updated.placementVersion);

    this.audit.log({
      action: `org.placement.${to.toLowerCase()}`,
      userId: actorUserId,
      orgId,
      targetId: orgId,
      targetType: "organization_placement",
      metadata: {
        from,
        to,
        placementVersion: updated.placementVersion,
        ...(reason !== undefined ? { reason } : {}),
      },
    });

    return updated;
  }
}
