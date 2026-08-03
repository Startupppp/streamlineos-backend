import type { TestingModuleBuilder } from "@nestjs/testing";
import {
  MembershipStateService,
  type MembershipState,
} from "src/common/auth/membership-state.service";

export interface MembershipStateOverride {
  active?: boolean;
  isOwner?: boolean;
  role?: string;
}

function toState(override: MembershipStateOverride): MembershipState {
  return {
    active: override.active ?? true,
    isOwner: override.isOwner ?? false,
    role: override.role ?? "MEMBER",
  };
}

export function stubMembershipState(
  builder: TestingModuleBuilder,
  byUserId: Record<string, MembershipStateOverride> = {},
  fallback: MembershipStateOverride = {},
): TestingModuleBuilder {
  const states = new Map<string, MembershipState>(
    Object.entries(byUserId).map(([userId, override]) => [
      userId,
      toState(override),
    ]),
  );
  const fallbackState = toState(fallback);

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
