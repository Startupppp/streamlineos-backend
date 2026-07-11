import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizations, users, departments, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { escapeHtml, sanitizeHtml } from "./html-sanitizer";
import { TEMPLATE_VARIABLES } from "./hr-template-variables";

type RenderContext = Record<string, string>;

function interpolate(template: string, ctx: RenderContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, raw: string) => {
    const token = raw.trim();
    if (token in ctx) return ctx[token];
    return `⟦missing:${token}⟧`;
  });
}

function buildPreviewContext(): RenderContext {
  const ctx: RenderContext = {};
  for (const v of TEMPLATE_VARIABLES) {
    if (!v.sensitive) ctx[v.token] = v.example;
  }
  return ctx;
}

@Injectable()
export class HrTemplateRenderService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async buildContext(
    orgId: string,
    userId: string,
    employeeId: number | undefined,
    extraContext: Record<string, string> | undefined,
    includeSensitive: boolean,
  ): Promise<RenderContext> {
    const ctx: RenderContext = {};

    const today = new Date();
    ctx["today"] = today.toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });

    const [org] = await this.db
      .select({ name: organizations.name, address: organizations.address, website: organizations.website, supportEmail: organizations.supportEmail })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (org) {
      ctx["company.name"] = org.name;
      ctx["company.website"] = org.website ?? "";
      ctx["company.hrEmail"] = org.supportEmail ?? "";
      if (org.address) {
        const a = org.address;
        ctx["company.address"] = [a.line1, a.city, a.state, a.country].filter(Boolean).join(", ");
      }
    }

    const actorUser = await this.db
      .select({ firstName: users.firstName, lastName: users.lastName, name: users.name, designation: users.designation })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (actorUser[0]) {
      const u = actorUser[0];
      const full = u.name ?? [u.firstName, u.lastName].filter(Boolean).join(" ");
      ctx["workflow.approverName"] = full;
      ctx["workflow.submittedOn"] = today.toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
    }

    if (employeeId !== undefined) {
      const [empRow] = await this.db
        .select({
          firstName: users.firstName,
          lastName: users.lastName,
          name: users.name,
          email: users.email,
          phone: users.phone,
          designation: users.designation,
          employeeId: users.employeeId,
          joiningDate: users.joiningDate,
          dateOfBirth: users.dateOfBirth,
          departmentId: users.departmentId,
          reportingTo: users.reportingTo,
          monthlySalary: users.monthlySalary,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.id, employeeId), eq(organizationMembers.orgId, orgId)))
        .limit(1);

      if (empRow) {
        const full = empRow.name ?? [empRow.firstName, empRow.lastName].filter(Boolean).join(" ");
        ctx["employee.fullName"] = full;
        ctx["employee.firstName"] = empRow.firstName ?? "";
        ctx["employee.lastName"] = empRow.lastName ?? "";
        ctx["employee.workEmail"] = empRow.email;
        ctx["employee.employeeNumber"] = empRow.employeeId ?? "";
        ctx["employee.designation"] = empRow.designation ?? "";
        ctx["role.title"] = empRow.designation ?? "";

        if (empRow.joiningDate) {
          ctx["employee.joiningDate"] = new Date(empRow.joiningDate).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
        }

        if (includeSensitive) {
          ctx["employee.phone"] = empRow.phone ?? "";
          if (empRow.dateOfBirth) {
            ctx["employee.dateOfBirth"] = new Date(empRow.dateOfBirth).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
          }
          if (empRow.monthlySalary) {
            const monthly = Number(empRow.monthlySalary);
            const annual = monthly * 12;
            ctx["salary.basic"] = `₹${monthly.toLocaleString("en-IN")}`;
            ctx["salary.grossMonthly"] = `₹${monthly.toLocaleString("en-IN")}`;
            ctx["salary.ctc"] = `₹${annual.toLocaleString("en-IN")}`;
          }
        }

        if (empRow.departmentId) {
          const [dept] = await this.db
            .select({ name: departments.name })
            .from(departments)
            .where(and(eq(departments.id, empRow.departmentId), eq(departments.orgId, orgId)))
            .limit(1);
          if (dept) ctx["department.name"] = dept.name;
        }

        if (empRow.reportingTo) {
          const [mgr] = await this.db
            .select({ firstName: users.firstName, lastName: users.lastName, name: users.name, designation: users.designation, email: users.email })
            .from(users)
            .where(eq(users.id, empRow.reportingTo))
            .limit(1);
          if (mgr) {
            ctx["manager.fullName"] = mgr.name ?? [mgr.firstName, mgr.lastName].filter(Boolean).join(" ");
            ctx["manager.designation"] = mgr.designation ?? "";
            ctx["manager.workEmail"] = mgr.email;
          }
        }
      }
    }

    if (extraContext) {
      for (const [k, v] of Object.entries(extraContext)) {
        ctx[k] = v;
      }
    }

    return ctx;
  }

  renderHtml(bodyHtml: string, ctx: RenderContext): string {
    const escapedCtx: RenderContext = {};
    for (const [k, v] of Object.entries(ctx)) {
      escapedCtx[k] = escapeHtml(v);
    }
    const withTokens = interpolate(bodyHtml, escapedCtx);
    return sanitizeHtml(withTokens);
  }

  buildPreviewContext(): RenderContext {
    return buildPreviewContext();
  }
}
