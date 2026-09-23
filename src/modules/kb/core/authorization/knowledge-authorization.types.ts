import type { SQL } from "drizzle-orm";

export const KB_PAGE_ACTIONS = ["view", "comment", "edit", "manage"] as const;
export type KbPageAction = (typeof KB_PAGE_ACTIONS)[number];

const ACTION_RANK: Record<KbPageAction, number> = {
  view: 0,
  comment: 1,
  edit: 2,
  manage: 3,
};

export function accessLevelsSatisfying(action: KbPageAction): KbPageAction[] {
  return KB_PAGE_ACTIONS.filter(
    (level) => ACTION_RANK[level] >= ACTION_RANK[action],
  );
}

export function accessSatisfies(
  held: KbPageAction,
  required: KbPageAction,
): boolean {
  return ACTION_RANK[held] >= ACTION_RANK[required];
}

export const KB_ACCESS_ROUTES = [
  "owner",
  "admin",
  "creator",
  "organization",
  "public",
  "space",
  "project",
  "grant",
] as const;
export type KbAccessRoute = (typeof KB_ACCESS_ROUTES)[number];

export interface KbPageScope {
  orgId: string;
  pageId: number;
  action: KbPageAction;
  via: KbAccessRoute;
}

export interface KbSpaceScope {
  orgId: string;
  spaceId: number;
  action: KbPageAction;
  via: KbAccessRoute;
}

export type AccessDecision<TScope> =
  | { outcome: "allowed"; scope: TScope }
  | { outcome: "notFound" }
  | { outcome: "denied"; reason: string };

export function allowed<TScope>(scope: TScope): AccessDecision<TScope> {
  return { outcome: "allowed", scope };
}

export function notFound<TScope>(): AccessDecision<TScope> {
  return { outcome: "notFound" };
}

export function denied<TScope>(reason: string): AccessDecision<TScope> {
  return { outcome: "denied", reason };
}

export interface VisiblePageScope {
  predicate: SQL<unknown>;
  grantBranch: SQL<unknown> | null;
  indexedBranch: SQL<unknown>;
  fingerprint: string;
}

export interface KbSharedWithMeScope {
  predicate: SQL<unknown>;
  membershipId: number | null;
  roleSlugs: string[];
  fingerprint: string;
}

export interface KbActorStanding {
  orgId: string;
  userId: string;
  membershipId: number | null;
  roleSlugs: string[];
  isOrgOwner: boolean;
  isKbAdmin: boolean;
  accessibleSpaceIds: number[];
  accessibleProjectIds: number[];
  permissionsVersion: number;
}
