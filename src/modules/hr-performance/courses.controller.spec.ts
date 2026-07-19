import { ConflictException } from "@nestjs/common";
import { CoursesController } from "./courses.controller";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function ctx(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    branchId: null,
    role: "EMPLOYEE",
    permissions: [],
    enabledModules: ["HR"],
    plan: "PROFESSIONAL",
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "sess-1",
  };
}

describe("CoursesController.enroll — re-enrollment is a real 409, not a silent success", () => {
  it("409s when the enrollment already exists (onConflictDoNothing returned nothing)", async () => {
    const courses = { enrollUser: jest.fn().mockResolvedValue(undefined) };
    const controller = new CoursesController(courses as never);

    await expect(controller.enroll(ctx(), 1)).rejects.toBeInstanceOf(ConflictException);
  });

  it("returns the enrollment on a genuine first-time enroll", async () => {
    const courses = { enrollUser: jest.fn().mockResolvedValue({ id: 1, courseId: 1, userId: "user-1" }) };
    const controller = new CoursesController(courses as never);

    const result = await controller.enroll(ctx(), 1);
    expect(result).toEqual({ id: 1, courseId: 1, userId: "user-1" });
  });
});
