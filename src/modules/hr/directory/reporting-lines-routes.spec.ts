import { GUARDS_METADATA, MODULE_METADATA } from "@nestjs/common/constants";
import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { RATE_LIMIT_TIER } from "../../../common/ratelimit/use-rate-limit.decorator";
import { IS_UNIVERSAL } from "../../../common/auth/universal.decorator";
import { HrDirectoryModule } from "./hr-directory.module";
import { EmployeesController } from "./employees.controller";
import { ReportingLinesController } from "./reporting-lines.controller";
import { ReportingLineBulkJobsController } from "./reporting-line-bulk-jobs.controller";
import { ReportingManagerPolicyController } from "./reporting-manager-policy.controller";
import { ReportingManagerRequestsController } from "./reporting-manager-requests.controller";
import { MyReportingManagerRequestsController } from "./reporting-manager-requests-me.controller";
import { MyReportingLineController } from "./my-reporting-line.controller";
import { HrImportController } from "../import/hr-import.controller";

/**
 * HRM-15 route safety that no type checks: Express matches in registration order, so a static
 * route registered after `GET hr/reporting-lines/:employeeUserId` is unreachable; and a mutating
 * command without its fence or rate tier is a retry away from a double write.
 */
describe("HRM-15 routes", () => {
  it("registers the bulk-jobs controller before the controller holding GET :employeeUserId under the same prefix", () => {
    const controllers: unknown[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, HrDirectoryModule) ?? [];
    const bulk = controllers.indexOf(ReportingLineBulkJobsController);
    const lines = controllers.indexOf(ReportingLinesController);
    expect(bulk).toBeGreaterThanOrEqual(0);
    expect(lines).toBeGreaterThan(bulk);
  });

  it("declares coverage and manager-candidates before :employeeUserId inside the controller", () => {
    const order = Object.getOwnPropertyNames(ReportingLinesController.prototype);
    expect(order.indexOf("coverage")).toBeLessThan(order.indexOf("line"));
    expect(order.indexOf("managerCandidates")).toBeLessThan(order.indexOf("line"));
    expect(order.indexOf("line")).toBeGreaterThan(0);
  });

  it.each([
    ["policy update", ReportingManagerPolicyController.prototype.update, "hr.reporting-manager-policy.update"],
    ["line set", ReportingLinesController.prototype.setLine, "hr.reporting-lines.set"],
    ["fallback confirm", ReportingLinesController.prototype.confirmFallback, "hr.reporting-lines.confirm-fallback"],
    ["request create", MyReportingManagerRequestsController.prototype.create, "self.reporting-manager-requests.create"],
    ["request cancel", MyReportingManagerRequestsController.prototype.cancel, "self.reporting-manager-requests.cancel"],
    ["request respond", MyReportingManagerRequestsController.prototype.respond, "self.reporting-manager-requests.respond"],
    ["request review", ReportingManagerRequestsController.prototype.review, "hr.reporting-manager-requests.review"],
    ["bulk preview", ReportingLineBulkJobsController.prototype.preview, "hr.reporting-line-bulk-jobs.preview"],
    ["bulk commit", ReportingLineBulkJobsController.prototype.commit, "hr.reporting-line-bulk-jobs.commit"],
    ["staged import commit", HrImportController.prototype.commitJob, "hr.import.jobs.commit"],
  ])("fences the %s command", (_name, handler, command) => {
    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler)).toBe(command);
  });

  it.each([
    ["bulk job preview", ReportingLineBulkJobsController.prototype.preview, "hr:reporting-line-bulk-preview"],
    ["bulk job commit", ReportingLineBulkJobsController.prototype.commit, "hr:reporting-line-bulk-commit"],
    ["bulk onboarding preview", EmployeesController.prototype.previewBulk, "hr:employee-bulk-onboard-preview"],
  ])("rate-limits the %s with its guard attached", (_name, handler, tier) => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, handler)).toBe(tier);
    expect(guards).toContain(RateLimitGuard);
  });

  it("does not fence the bulk-onboarding preview, which writes nothing", () => {
    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, EmployeesController.prototype.previewBulk)).toBeUndefined();
    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, EmployeesController.prototype.onboardBulk)).toBe("hr.employees.onboard-bulk");
  });

  it.each([
    ["my line", MyReportingLineController.prototype.get],
    ["my requests list", MyReportingManagerRequestsController.prototype.list],
    ["my request create", MyReportingManagerRequestsController.prototype.create],
  ])("exposes the self-service %s to every member, not behind an HR key", (_name, handler) => {
    expect(Reflect.getMetadata(IS_UNIVERSAL, handler)).toBe(true);
  });
});
