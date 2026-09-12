import { alias } from "drizzle-orm/pg-core";
import {
  hrEmployments,
  hrPeople,
  hrReportingLines,
  organizationMembers,
  users,
} from "../../../db/schema";

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

export const orgChartChildUsers = alias(users, "org_chart_child_users");
export const orgChartChildMembers = alias(organizationMembers, "org_chart_child_members");
export const orgChartManagerUsers = alias(users, "org_chart_manager_users");
export const orgChartManagerMembers = alias(organizationMembers, "org_chart_manager_members");

export const rlVis = alias(hrReportingLines, "rl_vis");
export const rlVisEmpEmp = alias(hrEmployments, "rl_vis_emp_emp");
export const rlVisEmpPpl = alias(hrPeople, "rl_vis_emp_ppl");
export const rlVisMgrEmp = alias(hrEmployments, "rl_vis_mgr_emp");
export const rlVisMgrPpl = alias(hrPeople, "rl_vis_mgr_ppl");

export const rlChild = alias(hrReportingLines, "rl_child");
export const rlChildMgrEmp = alias(hrEmployments, "rl_child_mgr_emp");
export const rlChildMgrPpl = alias(hrPeople, "rl_child_mgr_ppl");
export const rlChildEmpEmp = alias(hrEmployments, "rl_child_emp_emp");
export const rlChildEmpPpl = alias(hrPeople, "rl_child_emp_ppl");

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
