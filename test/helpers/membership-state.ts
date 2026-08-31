import type { TestingModuleBuilder } from "@nestjs/testing";
import {
  MembershipStateService,
  type MembershipState,
} from "src/common/auth/membership-state.service";

export interface MembershipStateOverride {
  active?: boolean;
  isOwner?: boolean;
  role?: string;
  membershipId?: number | null;
}

function toState(
  override: MembershipStateOverride,
  membershipId: number,
): MembershipState {
  return {
    active: override.active ?? true,
    isOwner: override.isOwner ?? false,
    role: override.role ?? "MEMBER",
    membershipId:
      override.membershipId === undefined
        ? membershipId
        : override.membershipId,
  };
}

export function stubMembershipState(
  builder: TestingModuleBuilder,
  byUserId: Record<string, MembershipStateOverride> = {},
  fallback: MembershipStateOverride = {},
): TestingModuleBuilder {
  const states = new Map<string, MembershipState>(
    Object.entries(byUserId).map(([userId, override], index) => [
      userId,
      toState(override, index + 1),
    ]),
  );
  const fallbackState = toState(fallback, Object.keys(byUserId).length + 1);

  return builder.overrideProvider(MembershipStateService).useValue({
    resolve: jest
      .fn()
      .mockImplementation(async (userId: string) =>
        states.get(userId) ?? fallbackState,
      ),
    isAccountActive: jest
      .fn()
      .mockImplementation(
        async (userId: string) =>
          (states.get(userId) ?? fallbackState).active,
      ),
  });
}
