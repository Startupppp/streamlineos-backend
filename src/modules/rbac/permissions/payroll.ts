import { definePermissions } from "./types";

export const PAYROLL_PERMISSIONS = definePermissions([
  {
    name: "payroll:runs:view",
    resource: "payroll:runs",
    action: "view",
    description: "View payroll runs",
    scopable: true,
  },
  {
    name: "payroll:runs:create",
    resource: "payroll:runs",
    action: "create",
    description: "Create payroll runs",
  },
  {
    name: "payroll:runs:update",
    resource: "payroll:runs",
    action: "update",
    description: "Update payroll runs",
  },
  {
    name: "payroll:runs:approve",
    resource: "payroll:runs",
    action: "approve",
    description: "Approve payroll runs",
  },
  {
    name: "payroll:runs:manage",
    resource: "payroll:runs",
    action: "manage",
    // Marking a batch or a run paid is `payroll:bank:manage`
    // (payout-batches.controller.ts). This key covers generate, recalculate,
    // adjustments, holds, exception overrides and lock/reopen/close.
    description: "Generate, recalculate, lock, reopen and close payroll runs",
  },
  {
    name: "payroll:salaries:view",
    resource: "payroll:salaries",
    action: "view",
    description: "View employee salary structures",
  },
  {
    name: "payroll:salaries:update",
    resource: "payroll:salaries",
    action: "update",
    description: "Update employee salaries",
  },
  {
    name: "payroll:templates:view",
    resource: "payroll:templates",
    action: "view",
    description: "View salary structure templates",
  },
  {
    name: "payroll:templates:manage",
    resource: "payroll:templates",
    action: "manage",
    description: "Manage salary structure templates",
  },
  {
    name: "payroll:policies:view",
    resource: "payroll:policies",
    action: "view",
    description: "View payroll policies",
  },
  {
    name: "payroll:policies:manage",
    resource: "payroll:policies",
    action: "manage",
    description: "Manage payroll policies",
  },
  {
    name: "payroll:components:view",
    resource: "payroll:components",
    action: "view",
    description: "View salary components",
  },
  {
    name: "payroll:components:manage",
    resource: "payroll:components",
    action: "manage",
    description: "Manage salary components (earnings and deductions)",
  },
  {
    name: "payroll:payslips:view",
    resource: "payroll:payslips",
    action: "view",
    description: "View payslips",
  },
  {
    name: "payroll:payslips:manage",
    resource: "payroll:payslips",
    action: "manage",
    description: "Publish and manage payslips",
  },
  {
    name: "payroll:bank:view",
    resource: "payroll:bank",
    action: "view",
    description: "View unmasked bank details (sensitive)",
    sensitive: true,
  },
  {
    name: "payroll:bank:manage",
    resource: "payroll:bank",
    action: "manage",
    description: "Manage bank transfer batches and mark paid",
  },
  {
    name: "payroll:tax:view",
    resource: "payroll:tax",
    action: "view",
    description: "View tax and statutory configurations",
  },
  {
    name: "payroll:tax:manage",
    resource: "payroll:tax",
    action: "manage",
    description: "Manage tax declarations and statutory rules",
  },
  {
    name: "payroll:reports:view",
    resource: "payroll:reports",
    action: "view",
    description: "View payroll reports",
  },
  {
    name: "payroll:reports:export",
    resource: "payroll:reports",
    action: "export",
    description: "Export payroll reports",
  },
  {
    name: "payroll:accounting:view",
    resource: "payroll:accounting",
    action: "view",
    description: "View payroll journal batches and accounting reconciliation",
  },
  {
    name: "payroll:accounting:manage",
    resource: "payroll:accounting",
    action: "manage",
    description:
      "Create, post, reverse, and reconcile payroll journal batches",
  },
  {
    name: "payroll:settings:manage",
    resource: "payroll:settings",
    action: "manage",
    description: "Manage payroll module settings",
  },
  {
    name: "payroll:fnf:view",
    resource: "payroll:fnf",
    action: "view",
    description: "View final settlements",
  },
  {
    name: "payroll:fnf:manage",
    resource: "payroll:fnf",
    action: "manage",
    description: "Manage final settlements",
  },
]);
