process.env.APP_URL ??= "http://localhost:1000";

import { BadRequestException } from "@nestjs/common";
import { EmployeeMutationsService } from "./employee-mutations.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function ctx(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId: "org-1",
    branchId: null,
    role: "HR",
    permissions: ["hr:employees:manage"],
    enabledModules: ["HR"],
    plan: "PROFESSIONAL",
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("EmployeeMutationsService.updateEmployee — termination shortcut is blocked", () => {
  it("rejects isActive:false unconditionally, even for an HR admin acting on another employee", async () => {
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({
            userId: "target-1",
            orgId: "org-1",
            role: "ENGINEERING",
            isOwner: false,
          }),
        },
      },
    };

    const service = new EmployeeMutationsService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await expect(
      service.updateEmployee(ctx(), "target-1", { isActive: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("EmployeeMutationsService.updateEmployee — role-slug bypass is closed", () => {
  function buildServiceWithTarget(targetRole: string) {
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({
            userId: "target-1",
            orgId: "org-1",
            role: targetRole,
            isOwner: false,
          }),
        },
      },
    };
    return new EmployeeMutationsService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  it("denies a CEO-role actor with no hr:employees:manage grant when editing another user", async () => {
    const service = buildServiceWithTarget("ENGINEERING");
    const ceoActor = ctx({ role: "CEO", permissions: [] });

    await expect(
      service.updateEmployee(ceoActor, "target-1", { designation: "Manager" }),
    ).rejects.toThrow("You can only update your own profile.");
  });

  it("denies an HR-role actor with no hr:employees:manage grant when editing another user", async () => {
    const service = buildServiceWithTarget("ENGINEERING");
    const hrActor = ctx({ role: "HR", permissions: [] });

    await expect(
      service.updateEmployee(hrActor, "target-1", { designation: "Manager" }),
    ).rejects.toThrow("You can only update your own profile.");
  });

  it("allows an actor whose permissions include hr:employees:manage", async () => {
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({
            userId: "target-1",
            orgId: "org-1",
            role: "ENGINEERING",
            isOwner: false,
          }),
        },
        users: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      transaction: jest.fn().mockResolvedValue(undefined),
    };
    const service = new EmployeeMutationsService(
      db as never,
      { invalidate: jest.fn() } as never,
      { log: jest.fn() } as never,
      { emit: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const grantedActor = ctx({ role: "MEMBER", permissions: ["hr:employees:manage"] });

    await expect(
      service.updateEmployee(grantedActor, "target-1", { designation: "Manager" }),
    ).resolves.toEqual({ success: true });
  });
});
