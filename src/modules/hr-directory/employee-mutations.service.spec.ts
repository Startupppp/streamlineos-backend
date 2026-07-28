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
