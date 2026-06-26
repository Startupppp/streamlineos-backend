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
    permissions: ["LEADS:READ", "LEADS:WRITE", "DEALS:READ", "DEALS:WRITE", "TASKS:READ", "TASKS:WRITE"],
  },
  {
    id: "hr_admin",
    name: "HR Administrator",
    slug: "HR_ADMIN",
    permissions: ["HR:READ", "HR:WRITE", "HR:DELETE", "LEAVES:READ", "LEAVES:WRITE", "PAYROLL:READ"],
  },
  {
    id: "recruiter",
    name: "Recruiter",
    slug: "RECRUITER",
    permissions: ["HR:READ", "RECRUITMENT:READ", "RECRUITMENT:WRITE", "CANDIDATES:READ", "CANDIDATES:WRITE"],
  },
  {
    id: "project_manager",
    name: "Project Manager",
    slug: "PROJECT_MANAGER",
    permissions: ["PROJECTS:READ", "PROJECTS:WRITE", "TICKETS:READ", "TICKETS:WRITE", "TIMESHEETS:READ"],
  },
  {
    id: "viewer",
    name: "Read-Only Viewer",
    slug: "VIEWER",
    permissions: ["LEADS:READ", "DEALS:READ", "PROJECTS:READ", "HR:READ", "REPORTS:READ"],
  },
  {
    id: "branch_manager",
    name: "Branch Manager",
    slug: "BRANCH_MANAGER",
    permissions: ["LEADS:READ", "LEADS:WRITE", "DEALS:READ", "DEALS:WRITE", "HR:READ", "REPORTS:READ", "TASKS:READ", "TASKS:WRITE"],
  },
];
