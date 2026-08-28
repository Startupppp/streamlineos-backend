import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizations, orgUnits, users, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { escapeHtml, sanitizeHtml } from "./html-sanitizer";
import { TEMPLATE_VARIABLES } from "./hr-template-variables";
import { EmploymentFactsService } from "../../directory/employment-facts.service";

type RenderContext = Record<string, string>;

function interpolate(template: string, ctx: RenderContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, raw: string) => {
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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly employment: EmploymentFactsService,
  ) {}

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

    const [[org], [actorUser]] = await Promise.all([
      this.db
        .select({ name: organizations.name, address: organizations.address, website: organizations.website, supportEmail: organizations.supportEmail })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
      this.db
        .select({ firstName: users.firstName, lastName: users.lastName, name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    ]);

    if (org) {
      ctx["company.name"] = org.name;
      ctx["company.website"] = org.website ?? "";
      ctx["company.hrEmail"] = org.supportEmail ?? "";
      if (org.address) {
        const a = org.address;
        ctx["company.address"] = [a.line1, a.city, a.state, a.country].filter(Boolean).join(", ");
      }
    }

    if (actorUser) {
      const full = actorUser.name ?? [actorUser.firstName, actorUser.lastName].filter(Boolean).join(" ");
      ctx["workflow.approverName"] = full;
      ctx["workflow.submittedOn"] = today.toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
    }

    if (employeeId !== undefined) {
      const [empRow] = await this.db
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          name: users.name,
          email: users.email,
          phone: users.phone,
          dateOfBirth: users.dateOfBirth,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.id, employeeId), eq(organizationMembers.orgId, orgId)))
        .limit(1);

      if (empRow) {
        const [facts, sensitiveFacts] = await Promise.all([
          this.employment.getFacts(orgId, empRow.id),
          includeSensitive ? this.employment.getSensitiveFacts(orgId, empRow.id) : Promise.resolve(null),
        ]);

        const full = empRow.name ?? [empRow.firstName, empRow.lastName].filter(Boolean).join(" ");
        ctx["employee.fullName"] = full;
        ctx["employee.firstName"] = empRow.firstName ?? "";
        ctx["employee.lastName"] = empRow.lastName ?? "";
        ctx["employee.workEmail"] = empRow.email;
        ctx["employee.employeeNumber"] = facts.employeeNumber ?? "";
        ctx["employee.designation"] = facts.designation ?? "";
        ctx["role.title"] = facts.designation ?? "";

        if (facts.joiningDate) {
          ctx["employee.joiningDate"] = new Date(facts.joiningDate).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
        }

        if (includeSensitive) {
          ctx["employee.phone"] = empRow.phone ?? "";
          if (empRow.dateOfBirth) {
            ctx["employee.dateOfBirth"] = new Date(empRow.dateOfBirth).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
          }
          if (sensitiveFacts?.salaryAmountCents) {
            const monthly = sensitiveFacts.salaryAmountCents;
            const annual = monthly * 12;
            ctx["salary.basic"] = `₹${monthly.toLocaleString("en-IN")}`;
            ctx["salary.grossMonthly"] = `₹${monthly.toLocaleString("en-IN")}`;
            ctx["salary.ctc"] = `₹${annual.toLocaleString("en-IN")}`;
          }
        }

        const [deptResult, mgrResult] = await Promise.all([
          facts.departmentId
            ? this.db
                .select({ name: orgUnits.name })
                .from(orgUnits)
                .where(and(eq(orgUnits.id, facts.departmentId), eq(orgUnits.orgId, orgId)))
                .limit(1)
            : Promise.resolve([]),
          facts.managerUserId
            ? this.db
                .select({ firstName: users.firstName, lastName: users.lastName, name: users.name, email: users.email })
                .from(users)
                .where(eq(users.id, facts.managerUserId))
                .limit(1)
            : Promise.resolve([]),
        ]);

        const dept = deptResult[0];
        if (dept) ctx["department.name"] = dept.name;

        const mgr = mgrResult[0];
        const mgrUserId = facts.managerUserId;
        if (mgr && mgrUserId) {
          const mgrFacts = await this.employment.getFacts(orgId, mgrUserId);
          ctx["manager.fullName"] = mgr.name ?? [mgr.firstName, mgr.lastName].filter(Boolean).join(" ");
          ctx["manager.designation"] = mgrFacts.designation ?? "";
          ctx["manager.workEmail"] = mgr.email;
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
