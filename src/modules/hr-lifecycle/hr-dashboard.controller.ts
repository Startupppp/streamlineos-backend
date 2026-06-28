import { Controller, ForbiddenException, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import { HrDashboardService } from "./hr-dashboard.service";
import { HrDashboardReportsService } from "./hr-dashboard-reports.service";
import { decrypt } from "./crypto.helpers";

const COMPLIANCE_ROLES = ["CEO", "ADMIN", "HR", "BRANCH_HR", "BRANCH_MANAGER"];
const EXPORT_ROLES = ["CEO", "ADMIN", "HR", "BRANCH_HR"];

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

@Controller("hr/dashboard")
@UseGuards(JwtAuthGuard)
export class HrDashboardController {
  constructor(
    private readonly dashboard: HrDashboardService,
    private readonly reports: HrDashboardReportsService,
  ) {}

  @Get("metrics")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  metrics(@CurrentUser() u: CurrentUserContext) {
    return this.dashboard.metrics(u.orgId);
  }

  @Get("diversity")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  diversity(@CurrentUser() u: CurrentUserContext) {
    return this.dashboard.diversity(u.orgId);
  }

  @Get("onboarding-status")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  onboardingStatus(@CurrentUser() u: CurrentUserContext) {
    return this.dashboard.onboardingStatus(u.orgId);
  }

  @Get("headcount-trends")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  headcountTrends(@CurrentUser() u: CurrentUserContext) {
    return this.reports.headcountTrends(u.orgId);
  }

  @Get("time-to-fill")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  timeToFill(@CurrentUser() u: CurrentUserContext) {
    return this.reports.timeToFill(u.orgId);
  }

  @Get("attendance-analytics")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  attendanceAnalytics(@CurrentUser() u: CurrentUserContext) {
    return this.reports.attendanceAnalytics(u.orgId);
  }

  @Get("compliance")
  compliance(@CurrentUser() u: CurrentUserContext) {
    if (!hasRoleOrPrivileged(u, COMPLIANCE_ROLES)) throw new ForbiddenException("Forbidden");
    return this.dashboard.compliance(u.orgId);
  }

  @Get("export")
  async export(@CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    if (!hasRoleOrPrivileged(u, EXPORT_ROLES)) throw new ForbiddenException("Forbidden");

    const rows = await this.reports.exportRows(u.orgId);

    const header = toRow([
      "Employee ID",
      "First Name",
      "Last Name",
      "Email",
      "Role",
      "Department",
      "Gender",
      "Date of Birth",
      "Joining Date",
      "Tax ID",
      "CRM Joined At",
    ]);

    const lines = rows.map((r) =>
      toRow([
        r.userId,
        r.firstName ?? "",
        r.lastName ?? (r.name ?? ""),
        r.email,
        r.role,
        r.departmentName ?? "",
        r.gender ?? "",
        r.dateOfBirth ?? "",
        r.joiningDate ?? "",
        r.taxId ? decrypt(r.taxId) : "",
        r.joinedAt ? new Date(r.joinedAt).toISOString().slice(0, 10) : "",
      ]),
    );

    const csv = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hr-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }
}
