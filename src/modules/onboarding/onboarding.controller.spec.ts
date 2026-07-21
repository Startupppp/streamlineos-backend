process.env.APP_URL ??= "http://localhost:1000";

import { ForbiddenException } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import type { ModuleChecklistService } from "../onboarding-flow/module-checklist.service";
import type { GuidedTourService } from "../onboarding-flow/guided-tour.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function ctx(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    branchId: null,
    role: "EMPLOYEE",
    permissions: [],
    enabledModules: ["HR", "CRM"],
    plan: "PROFESSIONAL",
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("OnboardingController — HR-only module-checklist gating", () => {
  let controller: OnboardingController;
  let onboarding: { getPersonalDetails: jest.Mock };
  let checklists: { [K in keyof ModuleChecklistService]?: jest.Mock };
  let tours: { [K in keyof GuidedTourService]?: jest.Mock };
  let access: { resolveUserPermissions: jest.Mock };

  beforeEach(() => {
    onboarding = {
      getPersonalDetails: jest.fn().mockResolvedValue({
        phone: "+919876543210",
        gender: "FEMALE",
        dateOfBirth: "1994-01-01",
        emergencyContact: null,
      }),
    };
    checklists = {
      listChecklists: jest.fn().mockResolvedValue([]),
      getChecklist: jest.fn().mockResolvedValue({ id: 1, moduleKey: "HR", items: [] }),
      completeItem: jest.fn().mockResolvedValue({ progress: 0, status: "in_progress" }),
      skipItem: jest.fn().mockResolvedValue({ progress: 0, status: "in_progress" }),
      dismissChecklist: jest.fn().mockResolvedValue({ dismissedAt: new Date() }),
      restartChecklist: jest.fn().mockResolvedValue({ progress: 0, status: "in_progress" }),
    };
    tours = {
      listToursForUser: jest.fn().mockResolvedValue([
        { id: 1, tourKey: "hr_setup", moduleKey: "HR", progress: null },
        { id: 2, tourKey: "product_tour", moduleKey: null, progress: null },
      ]),
      saveProgress: jest.fn().mockResolvedValue({ status: "in_progress", currentStep: 0 }),
      completeTour: jest.fn().mockResolvedValue({ status: "completed" }),
      dismissTour: jest.fn().mockResolvedValue({ status: "dismissed" }),
    };
    access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) };

    // Direct instantiation (not Test.createTestingModule) — this controller's class-level
    // @UseGuards(JwtAuthGuard) pulls in DRIZZLE/Redis-dependent guards that Nest's testing
    // module eagerly tries to resolve on .compile() even when unused by the methods under test.
    controller = new OnboardingController(
      onboarding as never,
      checklists as unknown as ModuleChecklistService,
      tours as unknown as GuidedTourService,
      undefined as never,
      access as never,
    );
  });

  it("loads the caller's tenant-scoped personal details", async () => {
    await expect(controller.getPersonalDetails(ctx())).resolves.toEqual({
      phone: "+919876543210",
      gender: "FEMALE",
      dateOfBirth: "1994-01-01",
      emergencyContact: null,
    });
    expect(onboarding.getPersonalDetails).toHaveBeenCalledWith("org-1", "user-1");
  });

  describe("getModuleChecklist", () => {
    it("throws ForbiddenException for moduleKey=HR when the caller has no hr:employees:* permission", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map());
      await expect(controller.getModuleChecklist("HR", ctx())).rejects.toBeInstanceOf(ForbiddenException);
      expect(checklists.getChecklist).not.toHaveBeenCalled();
    });

    it("allows moduleKey=HR through when the caller has hr:employees:view", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:view", "all"]]));
      await controller.getModuleChecklist("HR", ctx());
      expect(checklists.getChecklist).toHaveBeenCalledWith("org-1", "HR", ["HR", "CRM"]);
    });

    it("allows moduleKey=HR through when the caller has hr:employees:manage (implies view)", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:manage", "all"]]));
      await controller.getModuleChecklist("HR", ctx());
      expect(checklists.getChecklist).toHaveBeenCalled();
    });

    it("bypasses the DB permission check entirely for an org owner", async () => {
      await controller.getModuleChecklist("HR", ctx({ isOrgOwner: true }));
      expect(access.resolveUserPermissions).not.toHaveBeenCalled();
      expect(checklists.getChecklist).toHaveBeenCalled();
    });

    it("bypasses the DB permission check entirely for a platform admin", async () => {
      await controller.getModuleChecklist("HR", ctx({ isPlatformAdmin: true }));
      expect(access.resolveUserPermissions).not.toHaveBeenCalled();
      expect(checklists.getChecklist).toHaveBeenCalled();
    });

    it("does not run the HR check at all for other modules (no regression)", async () => {
      await controller.getModuleChecklist("CRM", ctx());
      expect(access.resolveUserPermissions).not.toHaveBeenCalled();
      expect(checklists.getChecklist).toHaveBeenCalledWith("org-1", "CRM", ["HR", "CRM"]);
    });
  });

  describe("mutating routes require hr:employees:manage specifically (view alone is not enough)", () => {
    it("completeChecklistItem: view-only permission is rejected", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:view", "all"]]));
      await expect(controller.completeChecklistItem("HR", "leave_policies", ctx())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("completeChecklistItem: manage permission is allowed", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:manage", "all"]]));
      await controller.completeChecklistItem("HR", "leave_policies", ctx());
      expect(checklists.completeItem).toHaveBeenCalled();
    });

    it("skipChecklistItem: no hr:* permission is rejected", async () => {
      await expect(
        controller.skipChecklistItem("HR", "recruitment_setup", { reason: undefined }, ctx()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(checklists.skipItem).not.toHaveBeenCalled();
    });

    it("dismissModuleChecklist: no hr:* permission is rejected", async () => {
      await expect(controller.dismissModuleChecklist("HR", ctx())).rejects.toBeInstanceOf(ForbiddenException);
      expect(checklists.dismissChecklist).not.toHaveBeenCalled();
    });

    it("restartModuleChecklist: no hr:* permission is rejected", async () => {
      await expect(controller.restartModuleChecklist("HR", ctx())).rejects.toBeInstanceOf(ForbiddenException);
      expect(checklists.restartChecklist).not.toHaveBeenCalled();
    });

    it("restartModuleChecklist: manage permission is allowed", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:manage", "all"]]));
      await controller.restartModuleChecklist("HR", ctx());
      expect(checklists.restartChecklist).toHaveBeenCalledWith("org-1", "HR", "user-1", ["HR", "CRM"]);
    });
  });

  describe("listModuleChecklists", () => {
    it("passes includeHr=false when the caller lacks hr:employees:* permission", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map());
      await controller.listModuleChecklists(ctx());
      expect(checklists.listChecklists).toHaveBeenCalledWith("org-1", ["HR", "CRM"], false);
    });

    it("passes includeHr=true when the caller has hr:employees:view", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:view", "all"]]));
      await controller.listModuleChecklists(ctx());
      expect(checklists.listChecklists).toHaveBeenCalledWith("org-1", ["HR", "CRM"], true);
    });

    it("passes includeHr=true for an org owner without hitting the DB", async () => {
      await controller.listModuleChecklists(ctx({ isOrgOwner: true }));
      expect(access.resolveUserPermissions).not.toHaveBeenCalled();
      expect(checklists.listChecklists).toHaveBeenCalledWith("org-1", ["HR", "CRM"], true);
    });
  });

  describe("guided-tour routes — the hr_setup tour is HR-only, every other tour stays baseline", () => {
    it("listTours: filters the hr_setup tour out of the response for a caller with no hr:* permission", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map());
      const result = await controller.listTours(ctx());
      expect(result.map((t: { tourKey: string }) => t.tourKey)).toEqual(["product_tour"]);
    });

    it("listTours: includes hr_setup for a caller with hr:employees:view", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:view", "all"]]));
      const result = await controller.listTours(ctx());
      expect(result.map((t: { tourKey: string }) => t.tourKey)).toEqual(["hr_setup", "product_tour"]);
    });

    it("listTours: includes hr_setup for an org owner without hitting the DB", async () => {
      const result = await controller.listTours(ctx({ isOrgOwner: true }));
      expect(access.resolveUserPermissions).not.toHaveBeenCalled();
      expect(result.map((t: { tourKey: string }) => t.tourKey)).toEqual(["hr_setup", "product_tour"]);
    });

    it("saveTourProgress: rejects tourKey=hr_setup for a caller with no hr:* permission", async () => {
      await expect(
        controller.saveTourProgress("hr_setup", { currentStep: 1 }, ctx()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tours.saveProgress).not.toHaveBeenCalled();
    });

    it("saveTourProgress: view permission is enough — a per-user row, unlike the org-wide checklist dismiss", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:view", "all"]]));
      await controller.saveTourProgress("hr_setup", { currentStep: 1 }, ctx());
      expect(tours.saveProgress).toHaveBeenCalledWith("org-1", "user-1", "hr_setup", 1);
    });

    it("saveTourProgress: never runs the HR check for a non-HR tourKey (no regression)", async () => {
      await controller.saveTourProgress("product_tour", { currentStep: 1 }, ctx());
      expect(access.resolveUserPermissions).not.toHaveBeenCalled();
      expect(tours.saveProgress).toHaveBeenCalledWith("org-1", "user-1", "product_tour", 1);
    });

    it("completeTour: rejects tourKey=hr_setup for a caller with no hr:* permission", async () => {
      await expect(controller.completeTour("hr_setup", ctx())).rejects.toBeInstanceOf(ForbiddenException);
      expect(tours.completeTour).not.toHaveBeenCalled();
    });

    it("dismissTour: rejects tourKey=hr_setup for a caller with no hr:* permission", async () => {
      await expect(controller.dismissTour("hr_setup", ctx())).rejects.toBeInstanceOf(ForbiddenException);
      expect(tours.dismissTour).not.toHaveBeenCalled();
    });

    it("dismissTour: view permission is enough (dismissing my own welcome popup doesn't touch shared org data)", async () => {
      access.resolveUserPermissions.mockResolvedValue(new Map([["hr:employees:view", "all"]]));
      await controller.dismissTour("hr_setup", ctx());
      expect(tours.dismissTour).toHaveBeenCalledWith("org-1", "user-1", "hr_setup");
    });

    it("dismissTour: bypasses the DB permission check for a platform admin", async () => {
      await controller.dismissTour("hr_setup", ctx({ isPlatformAdmin: true }));
      expect(access.resolveUserPermissions).not.toHaveBeenCalled();
      expect(tours.dismissTour).toHaveBeenCalled();
    });
  });
});
