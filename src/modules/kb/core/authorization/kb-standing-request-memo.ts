import { getObservabilityContext } from "../../../../common/observability/observability-context";
import type { KbActorStanding } from "./knowledge-authorization.types";

const perRequestStandings = new WeakMap<
  object,
  Map<string, Promise<KbActorStanding>>
>();

export function standingMemoKey(
  orgId: string,
  userId: string,
  membershipId: number | null,
  isOrgOwner: boolean,
): string {
  const membership = membershipId === null ? "none" : String(membershipId);
  const standing = isOrgOwner ? "owner" : "member";
  return [orgId, userId, membership, standing].join("\u0000");
}

export function memoizeStandingForRequest(
  key: string,
  resolve: () => Promise<KbActorStanding>,
): Promise<KbActorStanding> {
  const request = getObservabilityContext();
  if (request === undefined) return resolve();

  const existing = perRequestStandings.get(request);
  const slots =
    existing ?? new Map<string, Promise<KbActorStanding>>();
  if (existing === undefined) perRequestStandings.set(request, slots);

  const memoized = slots.get(key);
  if (memoized !== undefined) return memoized;

  const pending = resolve().catch((error: unknown) => {
    slots.delete(key);
    throw error;
  });
  slots.set(key, pending);
  return pending;
}
