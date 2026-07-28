export type { TemplateEntry } from "./_shared";

import type { TemplateEntry } from "./_shared";
import { authTemplates } from "./auth";
import { organizationTemplates } from "./organization";
import { hrLeaveTemplates } from "./hr-leave";
import { hrExpenseTemplates } from "./hr-expense";
import { projectsTemplates } from "./projects";
import { crmTemplates } from "./crm";
import { recruitmentTemplates } from "./recruitment";
import { interviewsTemplates } from "./interviews";
import { payrollTemplates } from "./payroll";
import { platformTemplates } from "./platform";
import { reportsTemplates } from "./reports";
import { notificationsTemplates } from "./notifications";

export const TEMPLATE_MAP: Record<string, TemplateEntry> = {
  ...authTemplates,
  ...organizationTemplates,
  ...hrLeaveTemplates,
  ...hrExpenseTemplates,
  ...projectsTemplates,
  ...crmTemplates,
  ...recruitmentTemplates,
  ...interviewsTemplates,
  ...payrollTemplates,
  ...platformTemplates,
  ...reportsTemplates,
  ...notificationsTemplates,
};
