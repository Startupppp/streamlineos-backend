import { GUARDS_METADATA } from "@nestjs/common/constants";
import { IDEMPOTENCY_COMMAND } from "../../common/idempotency/idempotency.constants";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { RATE_LIMIT_TIER } from "../../common/ratelimit/use-rate-limit.decorator";
import { HrEffectiveChangesController } from "./core/hr-effective-changes.controller";
import { HrPeopleController } from "./core/hr-people.controller";
import { EmployeesController } from "./directory/employees.controller";
import { OnboardingController } from "./onboarding/core/onboarding.controller";

describe("HR expensive command safety", () => {
  it.each([
    {
      name: "member backfill",
      handler: HrPeopleController.prototype.backfillFromMembers,
      command: "hr.people.backfill-from-members",
      tier: "hr:employee-backfill",
    },
    {
      name: "bulk onboarding",
      handler: EmployeesController.prototype.onboardBulk,
      command: "hr.employees.onboard-bulk",
      tier: "hr:employee-bulk-onboard",
    },
    {
      name: "effective-change application",
      handler: HrEffectiveChangesController.prototype.applyDue,
      command: "hr.effective-changes.apply-due",
      tier: "hr:effective-changes-apply",
    },
    {
      name: "onboarding reminders",
      handler: OnboardingController.prototype.sendReminders,
      command: "hr.onboarding.send-reminders",
      tier: "hr:onboarding-reminders",
    },
  ])("fences and rate-limits $name", ({ handler, command, tier }) => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];

    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler)).toBe(command);
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, handler)).toBe(tier);
    expect(guards).toContain(RateLimitGuard);
  });
});
