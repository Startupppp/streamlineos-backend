import { CRM_RECORDS_PERMISSIONS } from "./crm-records.permissions";
import { CRM_REVENUE_PERMISSIONS } from "./crm-revenue.permissions";
import { CRM_SALES_PERMISSIONS } from "./crm-sales.permissions";
import { CRM_WORKSPACE_PERMISSIONS } from "./crm-workspace.permissions";

/**
 * The CRM permission catalog.
 *
 * Held in four area files so no one file outgrows the size gate. This is still
 * the single exported catalog: `catalog.ts` and `index.ts` read
 * `CRM_PERMISSIONS`, never the slices, and the spread order below reproduces
 * the original key order exactly.
 */
export const CRM_PERMISSIONS = [
  ...CRM_SALES_PERMISSIONS,
  ...CRM_RECORDS_PERMISSIONS,
  ...CRM_WORKSPACE_PERMISSIONS,
  ...CRM_REVENUE_PERMISSIONS,
];
