export type PermissionTier = "STARTER" | "GROWTH" | "ENTERPRISE";

export interface CatalogPermission {
  key: string;
  module: string | null;
  resource: string;
  action: string;
  description: string;
  minTier: PermissionTier;
  scopable: boolean;
}

export const PERMISSION_CATALOG: CatalogPermission[] = [
  { key: "hr:employees:view", module: "hr", resource: "employees", action: "view", description: "View employees", minTier: "STARTER", scopable: true },
  { key: "hr:employees:create", module: "hr", resource: "employees", action: "create", description: "Create employees", minTier: "STARTER", scopable: false },
  { key: "hr:employees:update", module: "hr", resource: "employees", action: "update", description: "Update employees", minTier: "STARTER", scopable: true },
  { key: "hr:employees:delete", module: "hr", resource: "employees", action: "delete", description: "Delete employees", minTier: "GROWTH", scopable: false },
  { key: "hr:payroll:view", module: "hr", resource: "payroll", action: "view", description: "View payroll", minTier: "STARTER", scopable: true },
  { key: "hr:payroll:manage", module: "hr", resource: "payroll", action: "manage", description: "Manage payroll", minTier: "GROWTH", scopable: false },
  { key: "hr:recruitment:view", module: "hr", resource: "recruitment", action: "view", description: "View recruitment", minTier: "STARTER", scopable: true },
  { key: "hr:recruitment:manage", module: "hr", resource: "recruitment", action: "manage", description: "Manage recruitment", minTier: "GROWTH", scopable: false },
  { key: "crm:leads:view", module: "crm", resource: "leads", action: "view", description: "View leads", minTier: "STARTER", scopable: true },
  { key: "crm:leads:create", module: "crm", resource: "leads", action: "create", description: "Create leads", minTier: "STARTER", scopable: false },
  { key: "crm:leads:update", module: "crm", resource: "leads", action: "update", description: "Update leads", minTier: "STARTER", scopable: true },
  { key: "crm:leads:delete", module: "crm", resource: "leads", action: "delete", description: "Delete leads", minTier: "GROWTH", scopable: false },
  { key: "crm:contacts:view", module: "crm", resource: "contacts", action: "view", description: "View CRM contacts", minTier: "STARTER", scopable: true },
  { key: "crm:contacts:manage", module: "crm", resource: "contacts", action: "manage", description: "Manage CRM contacts", minTier: "STARTER", scopable: false },
  { key: "inventory:products:view", module: "inventory", resource: "products", action: "view", description: "View products", minTier: "STARTER", scopable: false },
  { key: "inventory:products:manage", module: "inventory", resource: "products", action: "manage", description: "Manage products", minTier: "STARTER", scopable: false },
  { key: "inventory:orders:view", module: "inventory", resource: "orders", action: "view", description: "View orders", minTier: "STARTER", scopable: true },
  { key: "inventory:orders:manage", module: "inventory", resource: "orders", action: "manage", description: "Manage orders", minTier: "GROWTH", scopable: false },
  { key: "settings:rbac:manage", module: null, resource: "rbac", action: "manage", description: "Manage roles & permissions", minTier: "STARTER", scopable: false },
  { key: "settings:org:manage", module: null, resource: "org", action: "manage", description: "Manage organization settings", minTier: "STARTER", scopable: false },
  { key: "settings:billing:manage", module: null, resource: "billing", action: "manage", description: "Manage billing", minTier: "STARTER", scopable: false },
  { key: "settings:automations:view", module: null, resource: "automations", action: "view", description: "View automations", minTier: "GROWTH", scopable: false },
  { key: "settings:automations:manage", module: null, resource: "automations", action: "manage", description: "Manage automations", minTier: "GROWTH", scopable: false },
  { key: "settings:custom-fields:manage", module: null, resource: "custom-fields", action: "manage", description: "Manage custom fields", minTier: "GROWTH", scopable: false },
  { key: "settings:integrations:manage", module: null, resource: "integrations", action: "manage", description: "Manage integrations", minTier: "GROWTH", scopable: false },
  { key: "kb:articles:view", module: "kb", resource: "articles", action: "view", description: "View knowledge base articles", minTier: "STARTER", scopable: true },
  { key: "kb:articles:manage", module: "kb", resource: "articles", action: "manage", description: "Manage knowledge base articles", minTier: "GROWTH", scopable: false },
  { key: "payroll:runs:view", module: "payroll", resource: "runs", action: "view", description: "View payroll runs", minTier: "GROWTH", scopable: true },
  { key: "payroll:runs:create", module: "payroll", resource: "runs", action: "create", description: "Create payroll runs", minTier: "GROWTH", scopable: false },
  { key: "payroll:runs:approve", module: "payroll", resource: "runs", action: "approve", description: "Approve payroll runs", minTier: "GROWTH", scopable: false },
  { key: "payroll:runs:manage", module: "payroll", resource: "runs", action: "manage", description: "Lock, reopen, and mark paid payroll runs", minTier: "ENTERPRISE", scopable: false },
  { key: "payroll:salaries:view", module: "payroll", resource: "salaries", action: "view", description: "View employee salaries", minTier: "GROWTH", scopable: false },
  { key: "payroll:salaries:manage", module: "payroll", resource: "salaries", action: "manage", description: "Manage salary configurations", minTier: "GROWTH", scopable: false },
  { key: "payroll:templates:view", module: "payroll", resource: "templates", action: "view", description: "View salary structure templates", minTier: "GROWTH", scopable: false },
  { key: "payroll:templates:manage", module: "payroll", resource: "templates", action: "manage", description: "Manage salary structure templates", minTier: "GROWTH", scopable: false },
  { key: "payroll:payslips:view", module: "payroll", resource: "payslips", action: "view", description: "View payslips", minTier: "GROWTH", scopable: false },
  { key: "payroll:payslips:manage", module: "payroll", resource: "payslips", action: "manage", description: "Publish and manage payslips", minTier: "GROWTH", scopable: false },
  { key: "payroll:bank:view", module: "payroll", resource: "bank", action: "view", description: "View unmasked bank details", minTier: "ENTERPRISE", scopable: false },
  { key: "payroll:bank:manage", module: "payroll", resource: "bank", action: "manage", description: "Manage bank transfers and mark paid", minTier: "ENTERPRISE", scopable: false },
  { key: "payroll:tax:view", module: "payroll", resource: "tax", action: "view", description: "View tax and statutory configurations", minTier: "GROWTH", scopable: false },
  { key: "payroll:tax:manage", module: "payroll", resource: "tax", action: "manage", description: "Manage tax and statutory rules", minTier: "GROWTH", scopable: false },
  { key: "payroll:reports:view", module: "payroll", resource: "reports", action: "view", description: "View payroll reports", minTier: "GROWTH", scopable: false },
  { key: "payroll:reports:export", module: "payroll", resource: "reports", action: "export", description: "Export payroll reports", minTier: "GROWTH", scopable: false },
  { key: "payroll:settings:manage", module: "payroll", resource: "settings", action: "manage", description: "Manage payroll module settings", minTier: "GROWTH", scopable: false },
  { key: "payroll:fnf:view", module: "payroll", resource: "fnf", action: "view", description: "View full and final settlements", minTier: "GROWTH", scopable: false },
  { key: "payroll:fnf:manage", module: "payroll", resource: "fnf", action: "manage", description: "Manage full and final settlements", minTier: "ENTERPRISE", scopable: false },
];
