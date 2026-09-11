import type { Permission } from "./types";

/**
 * CRM catalog: activities, settings, AI, tasks, campaigns, offer fulfilment,
 * autonomy, imports and issues.
 *
 * One slice of `CRM_PERMISSIONS`. `crm.ts` spreads the slices in a fixed
 * order and that order is the catalog order; nothing imports a slice directly.
 */
export const CRM_WORKSPACE_PERMISSIONS: Permission[] = [
  {
    name: "crm:activities:view",
    resource: "crm:activities",
    action: "view",
    description: "Read the unified timeline of calls, emails, meetings, notes and tasks",
  },
  {
    name: "crm:activities:manage",
    resource: "crm:activities",
    action: "manage",
    description: "Log, edit, complete and remove activities on the timeline",
  },
  /*
   * Custom field definitions are CRM-owned: `custom_field_definitions` is shared
   * with Support, HR and Build, but the four routes that reach it constrain both
   * their reads and their writes to `lead | deal | contact`. They were served at
   * the global `/settings/custom-fields` path behind `settings:custom-fields:*`,
   * a pair no seeded rung and no template carries, so a CRM_MODULE_ADMIN could
   * not open CRM's own screen. Naming them in the `crm` namespace is what puts
   * them on the module rung: `moduleScopedPermissions("crm")` picks them up with
   * no MODULE_ADMIN_EXTRA_KEYS entry, and `RoleGrantReconcilerService` delivers
   * them to organisations that already exist.
   */
  {
    name: "crm:custom-fields:view",
    resource: "crm:custom-fields",
    action: "view",
    description: "View CRM custom field definitions",
  },
  {
    name: "crm:custom-fields:manage",
    resource: "crm:custom-fields",
    action: "manage",
    description: "Create, edit and remove CRM custom field definitions",
  },
  {
    name: "crm:settings:view",
    resource: "crm:settings",
    action: "view",
    description:
      "View CRM configuration (pipelines, stages, options, validation rules, blueprints)",
  },
  {
    name: "crm:settings:manage",
    resource: "crm:settings",
    action: "manage",
    description:
      "Manage CRM configuration (pipelines, stages, options, validation rules, blueprints)",
  },
  {
    name: "crm:ai:use",
    resource: "crm:ai",
    action: "use",
    description:
      "Use CRM AI features (scoring, enrichment, briefs, email generation)",
  },
  {
    name: "crm:tasks:view",
    resource: "crm:tasks",
    action: "view",
    description: "View CRM tasks and inbox",
    scopable: true,
  },
  {
    name: "crm:tasks:update",
    resource: "crm:tasks",
    action: "update",
    description: "Update, complete, and snooze CRM tasks",
    scopable: true,
  },
  {
    name: "crm:campaigns:view",
    resource: "crm:campaigns",
    action: "view",
    description: "View CRM campaigns, attribution reports, and ROI metrics",
  },
  {
    name: "crm:campaigns:manage",
    resource: "crm:campaigns",
    action: "manage",
    description: "Create, update, and delete CRM campaigns",
  },
  {
    name: "crm:offer-fulfillment:view",
    resource: "crm:offer-fulfillment",
    action: "view",
    description: "View CRM offer → Inventory SKU fulfillment mappings",
  },
  {
    name: "crm:offer-fulfillment:create",
    resource: "crm:offer-fulfillment",
    action: "create",
    description: "Create CRM offer → Inventory SKU fulfillment mappings",
  },
  {
    name: "crm:offer-fulfillment:update",
    resource: "crm:offer-fulfillment",
    action: "update",
    description: "Update CRM offer → Inventory SKU fulfillment mappings",
  },
  {
    name: "crm:offer-fulfillment:delete",
    resource: "crm:offer-fulfillment",
    action: "delete",
    description: "Delete CRM offer → Inventory SKU fulfillment mappings",
  },
  {
    name: "crm:autonomy:view",
    resource: "crm:autonomy",
    action: "view",
    description: "Review what the CRM decided and did on its own",
    // Scopable so a rep restricted to their own deals sees only the actions
    // taken on those, matching how the deals list narrows.
    scopable: true,
  },
  {
    name: "crm:autonomy:reverse",
    resource: "crm:autonomy",
    action: "reverse",
    description: "Reverse an autonomous CRM action",
  },
  {
    name: "crm:autonomy:manage",
    resource: "crm:autonomy",
    action: "manage",
    description: "Turn autonomous CRM action types on or off for the organisation",
  },
  {
    // Separate from `:manage`, which governs whether an action type runs at all.
    // This one governs whether the system may change stored customer data with
    // nobody watching, and that is a different thing to hand somebody.
    name: "crm:autonomy:repair",
    resource: "crm:autonomy",
    action: "repair",
    description:
      "Choose which classes of data problem the CRM may repair unattended, and run the repair loop",
  },
  {
    name: "crm:imports:manage",
    resource: "crm:imports",
    action: "manage",
    description: "Bring a CRM export into StreamlineOS, and take an import back out",
  },
  {
    name: "crm:issues:view",
    resource: "crm:issues",
    action: "view",
    description: "View internal issues, internal tasks and customer complaints",
    // Scopable so a member restricted to their own work sees the records they
    // own rather than the organisation's, matching how `crm:deals:read` narrows.
    scopable: true,
  },
  {
    name: "crm:issues:manage",
    resource: "crm:issues",
    action: "manage",
    description:
      "Raise, edit and move internal issues, internal tasks and customer complaints",
  },
  {
    // Separate from managing, because deciding that somebody's handling was not
    // good enough is a different authority from working the record — and one
    // that must be grantable without granting the other.
    name: "crm:issues:escalate",
    resource: "crm:issues",
    action: "escalate",
    description: "Escalate an issue, task or complaint above its owner",
  },
];
