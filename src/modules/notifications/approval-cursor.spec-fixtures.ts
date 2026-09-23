import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { ApprovalAdapterRegistry } from "../attention/approval-adapter.registry";
import { UnifiedInboxService } from "./unified-inbox.service";
import type { InboxKind } from "./dto/unified-inbox.schemas";

export const ORG = "org-1";
export const OTHER_ORG = "org-2";
export const UID = "approver-user";
export const MEMBERSHIP = 1;
export const OTHER_MEMBERSHIP = 2;

export const T_A = new Date("2026-09-20T00:00:00.000Z");
export const T_B = new Date("2026-09-19T00:00:00.000Z");
export const T_C = new Date("2026-09-18T00:00:00.000Z");

export type Seed = { id: number; at: Date };

export const TIED_SEEDS: Seed[] = [
  { id: 50, at: T_A },
  { id: 30, at: T_A },
  { id: 10, at: T_A },
  { id: 40, at: T_B },
  { id: 20, at: T_B },
];

export const EXPECTED_ORDER = [50, 30, 10, 40, 20];

export const LAST_DELIVERED_ON_PAGE_ONE = { id: 30, t: T_A.toISOString() };
export const FIRST_TRIMMED_ON_PAGE_ONE = 10;

export function makeAccess(): AccessService {
  return {
    holds: jest.fn().mockResolvedValue(true),
    membersWithPermission: jest.fn().mockResolvedValue([]),
  } as unknown as AccessService;
}

export function makeMail(): MailService {
  return {
    listMessages: jest.fn().mockResolvedValue({ messages: [], nextCursor: null, accountErrors: [] }),
    countUnread: jest.fn(),
    areAllAccountsFresh: jest.fn().mockResolvedValue(true),
  } as unknown as MailService;
}

export function makeBroadcasts(): BroadcastsService {
  return { listInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BroadcastsService;
}

export function makeBuildApprovals(): BuildApprovalsInboxService {
  return { getInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BuildApprovalsInboxService;
}

export function makeUser(): CurrentUserContext {
  return {
    userId: UID,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: MEMBERSHIP, isOrgOwner: false },
  } as CurrentUserContext;
}

export function makeInbox(db: Db, registry: ApprovalAdapterRegistry): UnifiedInboxService {
  return new UnifiedInboxService(
    db,
    makeAccess(),
    makeMail(),
    makeBroadcasts(),
    makeBuildApprovals(),
    registry,
  );
}

export async function scrollApprovals(
  svc: UnifiedInboxService,
  limit: number,
  maxPages: number,
): Promise<string[]> {
  const kinds: InboxKind[] = ["build_approval"];
  const delivered: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result = await svc.list(ORG, UID, { limit, kinds, unreadOnly: false, cursor }, makeUser());
    for (const item of result.items) delivered.push(item.dedupKey);
    if (!result.hasMore || result.nextCursor === null) break;
    cursor = result.nextCursor;
  }

  return delivered;
}

export function orgMemberRows() {
  return [
    { id: MEMBERSHIP, org_id: ORG, user_id: UID },
    { id: OTHER_MEMBERSHIP, org_id: ORG, user_id: "other-user" },
  ];
}

export function userRows() {
  return [
    {
      id: UID,
      name: "Approver One",
      first_name: "Approver",
      last_name: "One",
      image: null,
      email: "approver@example.com",
    },
    {
      id: "requester-user",
      name: "Requester Two",
      first_name: "Requester",
      last_name: "Two",
      image: null,
      email: "requester@example.com",
    },
  ];
}
