export interface RoleTemplate {
  id: string;
  name: string;
  slug: string;
  permissions: readonly string[];
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    id: "sales_rep",
    name: "Sales Representative",
    slug: "SALES_REP",
    permissions: [
      "crm:leads:view",
      "crm:leads:create",
      "crm:leads:update",
      "crm:deals:read",
      "crm:deals:create",
    ],
  },
  {
    id: "hr_admin",
    name: "HR Administrator",
    slug: "HR_ADMIN",
    permissions: [
      "hr:employees:read",
      "hr:employees:manage",
      "hr:leaves:read",
      "hr:leaves:manage",
      "hr:payroll:view",
      "hr:payroll:generate",
      "hr:payroll:approve",
    ],
  },
  {
    id: "recruiter",
    name: "Recruiter",
    slug: "RECRUITER",
    permissions: [
      "hr:employees:read",
      "hr:onboarding:manage",
    ],
  },
  {
    id: "project_manager",
    name: "Project Manager",
    slug: "PROJECT_MANAGER",
    permissions: [
      "projects:view",
      "projects:create",
      "projects:manage",
      "projects:tickets:view",
      "projects:tickets:create",
      "projects:tickets:update",
      "projects:tickets:assign",
      "projects:sprints:view",
      "projects:sprints:manage",
      "projects:timesheets:view",
      "projects:timesheets:manage",
    ],
  },
  {
    id: "viewer",
    name: "Read-Only Viewer",
    slug: "VIEWER",
    permissions: [
      "crm:leads:view",
      "crm:deals:read",
      "projects:view",
      "projects:tickets:view",
      "hr:employees:read",
      "reports:view",
    ],
  },
  {
    id: "branch_manager",
    name: "Branch Manager",
    slug: "BRANCH_MANAGER",
    permissions: [
      "crm:leads:view",
      "crm:leads:create",
      "crm:leads:update",
      "crm:deals:read",
      "crm:deals:create",
      "hr:employees:read",
      "reports:view",
    ],
  },
];
