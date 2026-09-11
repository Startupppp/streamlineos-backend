import type {
  MembershipState,
  MembershipStateService,
} from "../../src/common/auth/membership-state.service";

export const LIVE_MEMBERSHIP: MembershipState = {
  active: true,
  isOwner: false,
  role: "MEMBER",
  membershipId: 1,
};

export function membershipState(
  partial: Partial<MembershipState> = {},
): MembershipState {
  return { ...LIVE_MEMBERSHIP, ...partial };
}

/** The liveness authority as a double; `resolve` is a jest.fn so call counts bite. */
export function makeMembershipStateStub(
  state: Partial<MembershipState> | (() => Partial<MembershipState>) = {},
): MembershipStateService {
  const read = (): MembershipState =>
    membershipState(typeof state === "function" ? state() : state);
  return {
    resolve: jest.fn(async () => read()),
    isAccountActive: jest.fn(async () => read().active),
  } as unknown as MembershipStateService;
}

/** The authority's answer for a row shaped the way these fixtures declare it. */
export function stateFromRow(row: {
  isOwner?: boolean;
  status?: string;
  id?: number | null;
  role?: string;
}): MembershipState {
  return {
    active: row.status === "ACTIVE",
    isOwner: row.isOwner ?? false,
    role: row.role ?? "MEMBER",
    membershipId: row.id ?? null,
  };
}

export function membershipReader(
  state: Partial<MembershipState> = {},
): jest.Mock<Promise<MembershipState>, [string, string]> {
  return jest.fn(async (_orgId: string, _userId: string) => membershipState(state));
}

/** Mirrors the `organization_members` row these fixtures used to hand the resolver. */
export function memberRowReader(row: {
  isOwner?: boolean;
  status?: string;
  id?: number | null;
  role?: string;
}): (orgId: string, userId: string) => Promise<MembershipState> {
  return async () => ({
    active: row.status === "ACTIVE",
    isOwner: row.isOwner ?? false,
    role: row.role ?? "MEMBER",
    membershipId: row.id ?? null,
  });
}

interface MemberRowFixture {
  isOwner?: boolean;
  status?: string;
  id?: number | null;
  role?: string;
}

/** Keeps a spec's existing `organizationMembers` fixture as its membership source. */
export function membershipStubFromDb(db: unknown): MembershipStateService {
  const findFirst = (
    db as {
      query?: {
        organizationMembers?: { findFirst?: () => Promise<MemberRowFixture | null> };
      };
    }
  ).query?.organizationMembers?.findFirst;
  return {
    resolve: jest.fn(async () => stateFromRow((await findFirst?.()) ?? {})),
    isAccountActive: jest.fn(async () => true),
  } as unknown as MembershipStateService;
}
