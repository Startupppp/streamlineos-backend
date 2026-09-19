import { alias, type PgTable } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  hrReportingLines,
  organizationMembers,
  users,
} from "../../../db/schema";

function aliasWithSource<T extends PgTable, A extends string>(base: T, aliasName: A) {
  return [alias(base, aliasName), sql`${base} ${sql.identifier(aliasName)}`] as const;
}

export interface OrgChartNode {
  id: string;
  name: string;
  role: string;
  designation: string | null;
  image: string | null;
  departmentId: string | null;
  departmentName: string | null;
  hasDirectReports: boolean;
}

export interface OrgChartPage {
  data: OrgChartNode[];
  pageInfo: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export const [orgChartChildUsers, orgChartChildUsersSource] = aliasWithSource(users, "org_chart_child_users");
export const [orgChartChildMembers, orgChartChildMembersSource] = aliasWithSource(organizationMembers, "org_chart_child_members");
export const [orgChartManagerUsers, orgChartManagerUsersSource] = aliasWithSource(users, "org_chart_manager_users");
export const [orgChartManagerMembers, orgChartManagerMembersSource] = aliasWithSource(organizationMembers, "org_chart_manager_members");

export const [rlVis, rlVisSource] = aliasWithSource(hrReportingLines, "rl_vis");
export const [rlVisEmpEmp, rlVisEmpEmpSource] = aliasWithSource(hrEmployments, "rl_vis_emp_emp");
export const [rlVisEmpPpl, rlVisEmpPplSource] = aliasWithSource(hrPeople, "rl_vis_emp_ppl");
export const [rlVisMgrEmp, rlVisMgrEmpSource] = aliasWithSource(hrEmployments, "rl_vis_mgr_emp");
export const [rlVisMgrPpl, rlVisMgrPplSource] = aliasWithSource(hrPeople, "rl_vis_mgr_ppl");

export const [rlChild, rlChildSource] = aliasWithSource(hrReportingLines, "rl_child");
export const [rlChildMgrEmp, rlChildMgrEmpSource] = aliasWithSource(hrEmployments, "rl_child_mgr_emp");
export const [rlChildMgrPpl, rlChildMgrPplSource] = aliasWithSource(hrPeople, "rl_child_mgr_ppl");
export const [rlChildEmpEmp, rlChildEmpEmpSource] = aliasWithSource(hrEmployments, "rl_child_emp_emp");
export const [rlChildEmpPpl, rlChildEmpPplSource] = aliasWithSource(hrPeople, "rl_child_emp_ppl");

export function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function escapeLikeValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
