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
];
