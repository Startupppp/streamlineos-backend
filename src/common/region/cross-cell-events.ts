export const CROSS_CELL_EVENT_TYPES = [
  "control-plane.placement.created",
  "control-plane.placement.moved",
  "control-plane.placement.fence-rotated",
  "control-plane.placement.retired",
  "control-plane.organization.created",
  "control-plane.organization.archived",
  "control-plane.organization.purged",
  "control-plane.account-organization-index.updated",
] as const;

export type CrossCellEventType = (typeof CROSS_CELL_EVENT_TYPES)[number];

const ALLOWED: ReadonlySet<string> = new Set<string>(CROSS_CELL_EVENT_TYPES);

export function isCrossCellEventType(
  value: string,
): value is CrossCellEventType {
  return ALLOWED.has(value);
}

export type CrossCellVerdict =
  | { readonly allowed: true; readonly eventType: CrossCellEventType }
  | {
      readonly allowed: false;
      readonly eventType: string;
      readonly reason: string;
    };

export function mayCrossCells(eventType: string): CrossCellVerdict {
  if (isCrossCellEventType(eventType)) return { allowed: true, eventType };

  return {
    allowed: false,
    eventType,
    reason:
      `"${eventType}" is a cell-local event. Only control-plane facts cross a cell boundary; ` +
      `a tenant's domain events stay in the cell that owns the tenant.`,
  };
}

export class CrossCellEventRefusedError extends Error {
  constructor(
    readonly eventType: string,
    reason: string,
  ) {
    super(`[cell] refusing to publish across cells: ${reason}`);
    this.name = "CrossCellEventRefusedError";
  }
}

export function assertMayCrossCells(eventType: string): CrossCellEventType {
  const verdict = mayCrossCells(eventType);
  if (!verdict.allowed)
    throw new CrossCellEventRefusedError(eventType, verdict.reason);
  return verdict.eventType;
}

export function isCellLocalEventType(eventType: string): boolean {
  return !isCrossCellEventType(eventType);
}
