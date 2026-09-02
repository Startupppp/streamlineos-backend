import { Reflector } from "@nestjs/core";
import { REQUIRE_MODULE } from "../../common/rbac/require-module.decorator";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { IS_UNIVERSAL } from "../../common/auth/universal.decorator";
import { LeaveCalendarController, LeavesController } from "./time/leaves.controller";
import { AttendanceController } from "./time/attendance.controller";
import { HrDisciplinaryController } from "./cases/hr-disciplinary.controller";
import { OnboardingViewsController } from "./lifecycle/onboarding-views.controller";

type ControllerClass = new (...args: never[]) => object;

const reflector = new Reflector();

function handlersOf(controller: ControllerClass): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof (controller.prototype as Record<string, unknown>)[name] ===
        "function",
  );
}

function permissionKeys(controller: ControllerClass): string[] {
  const classKey = reflector.get<string>(REQUIRE_PERMISSION, controller);
  const keys = classKey ? [classKey] : [];
  for (const name of handlersOf(controller)) {
    const handler = (controller.prototype as Record<string, unknown>)[name];
    const key = reflector.get<string>(REQUIRE_PERMISSION, handler as never);
    if (key) keys.push(key);
  }
  return keys;
}

function carriesUniversal(controller: ControllerClass): boolean {
  if (reflector.get<boolean>(IS_UNIVERSAL, controller)) return true;
  return handlersOf(controller).some((name) =>
    reflector.get<boolean>(
      IS_UNIVERSAL,
      (controller.prototype as Record<string, unknown>)[name] as never,
    ),
  );
}

function moduleOf(controller: ControllerClass): string | undefined {
  return reflector.get<string>(REQUIRE_MODULE, controller);
}

const ADMIN_ONLY_HR_CONTROLLERS: ReadonlyArray<[string, ControllerClass]> = [
  ["LeavesController", LeavesController],
  ["LeaveCalendarController", LeaveCalendarController],
  ["AttendanceController", AttendanceController],
];

describe("HR module gating", () => {
  it.each(ADMIN_ONLY_HR_CONTROLLERS)(
    "%s carries @RequireModule(\"hr\") because every route it exposes is HR administration",
    (_name, controller) => {
      expect(permissionKeys(controller).length).toBeGreaterThan(0);
      expect(
        permissionKeys(controller).every((key) => key.startsWith("hr:")),
      ).toBe(true);
      expect(carriesUniversal(controller)).toBe(false);
      expect(moduleOf(controller)).toBe("hr");
    },
  );

  it("does not module-gate the controllers that also serve a self:* route", () => {
    for (const controller of [
      HrDisciplinaryController,
      OnboardingViewsController,
    ]) {
      const keys = permissionKeys(controller);
      expect(keys.some((key) => key.startsWith("self:"))).toBe(true);
      expect(moduleOf(controller)).toBeUndefined();
    }
  });

  it("reads real decorator metadata — an undecorated class resolves to undefined", () => {
    class Undecorated {
      handler() {
        return null;
      }
    }
    expect(moduleOf(Undecorated)).toBeUndefined();
    expect(permissionKeys(Undecorated)).toEqual([]);
  });
});
