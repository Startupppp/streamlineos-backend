import { definePermissions } from "./types";

/**
 * CRM catalog: contacts, quotes, client management, the CRM configuration surfaces,
 * organisations, customer 360 and inbound ingress.
 *
 * One slice of `CRM_PERMISSIONS`. `crm.ts` spreads the slices in a fixed
 * order and that order is the catalog order; nothing imports a slice directly.
 */
export const CRM_RECORDS_PERMISSIONS = definePermissions([
  {
    /*
      NOT scopable, where the neighbouring CRM read keys are — because a contact
      has no owner to scope by, anywhere in the model.

      It was declared `scopable: true` when the key was born (dbb946d68), in a
      commit that gated the CRM controllers in bulk and gave the flag to
      `crm:quotes:read` in the same stroke. The precedent it was copied from is
      real: 5a6261d97 made the lead keys scopable, and a lead genuinely has
      `assigned_to_id`. A contact never did.

      Three places would have to carry that owner, and none does. The legacy
      `contacts` row has no owner column — its only associations are
      `organization_id`, `lead_id` and `deal_id`. Party, which is canonical since
      ticket 02 and where these reads actually resolve, keeps
      `business_parties.owner_user_id` — but `party-mirror-fields.ts` maps it for
      LEAD (`assigned_to_id`) and CLIENT (`account_manager_id`) only, so a party
      holding the CONTACT role has it null by construction. And the employer
      fallback — "contacts at accounts I own" — has nowhere to stand either:
      `crm_organizations` has no owner column.

      So `own` could only ever have meant "contacts I am somehow near", and the
      honest reading is that it meant nothing. The successor agrees: the route
      this key's list is deprecated towards, `party:contacts:view`, is not
      scopable, and `permissions/party.ts` declares no scopable key at all.

      Removing the promise rather than inventing an owner to satisfy it: a key
      that offers a restriction it cannot apply is worse than one that does not
      offer it, because the grant is accepted, stored and shown back on the
      access screen while every row stays visible.

      `crm:contacts:manage` was never scopable, so nothing changes on the write
      side. Pinned by `crm-contacts-scope.spec.ts`; the already-issued `own` and
      `team` offers are withdrawn from existing databases by migration 0670,
      because `PermissionCatalogSyncService` only ever inserts into
      `permission_supported_scopes` and would have left them standing.
    */
    name: "crm:contacts:view",
    resource: "crm:contacts",
    action: "view",
    description: "View CRM contacts",
  },
  {
    name: "crm:contacts:manage",
    resource: "crm:contacts",
    action: "manage",
    description: "Manage CRM contacts",
  },
  {
    name: "crm:quotes:read",
    resource: "crm:quotes",
    action: "read",
    description: "View CRM quotes",
    scopable: true,
  },
  {
    name: "crm:quotes:create",
    resource: "crm:quotes",
    action: "create",
    description: "Create CRM quotes",
  },
  {
    name: "crm:quotes:update",
    resource: "crm:quotes",
    action: "update",
    description: "Update CRM quotes",
  },
  {
    name: "crm:quotes:delete",
    resource: "crm:quotes",
    action: "delete",
    description: "Delete CRM quotes",
  },
  {
    name: "crm:clients:manage",
    resource: "crm:clients",
    action: "manage",
    description: "Manage client accounts",
  },
  {
    name: "crm:assignment-rules:manage",
    resource: "crm:assignment-rules",
    action: "manage",
    description: "Manage lead assignment rules",
  },
  {
    name: "crm:email-templates:manage",
    resource: "crm:email-templates",
    action: "manage",
    description: "Manage CRM email templates",
  },
  {
    name: "crm:scoring-rules:manage",
    resource: "crm:scoring-rules",
    action: "manage",
    description: "Manage lead scoring rules",
  },
  {
    name: "crm:sla:manage",
    resource: "crm:sla",
    action: "manage",
    description: "Manage CRM SLA policies",
  },
  {
    name: "crm:organizations:view",
    resource: "crm:organizations",
    action: "view",
    description: "View CRM organizations",
  },
  {
    name: "crm:organizations:manage",
    resource: "crm:organizations",
    action: "manage",
    description: "Manage CRM organizations",
  },
  {
    name: "crm:web-forms:manage",
    resource: "crm:web-forms",
    action: "manage",
    description: "Manage CRM web forms",
  },
  {
    name: "crm:territories:manage",
    resource: "crm:territories",
    action: "manage",
    description: "Manage CRM territories",
  },
  {
    name: "crm:automations:manage",
    resource: "crm:automations",
    action: "manage",
    description: "Manage CRM automation rules",
  },
  {
    name: "crm:sequences:manage",
    resource: "crm:sequences",
    action: "manage",
    description: "Manage CRM email/call sequences",
  },
  {
    name: "crm:products:manage",
    resource: "crm:products",
    action: "manage",
    description: "Manage the CRM product catalog",
  },
  {
    name: "crm:pricebooks:manage",
    resource: "crm:pricebooks",
    action: "manage",
    description: "Manage price books and quote settings",
  },
  {
    name: "crm:quotes:approve",
    resource: "crm:quotes",
    action: "approve",
    description: "Approve or reject quotes requiring approval",
  },
  {
    name: "crm:organizations:merge",
    resource: "crm:organizations",
    action: "merge",
    description: "Merge duplicate CRM organizations/companies",
  },
  {
    name: "crm:customer360:view",
    resource: "crm:customer360",
    action: "view",
    description:
      "View Customer 360 aggregated profile (respects per-module permissions)",
  },
  {
    // The seam every provider adapter posts into. Gated because an open ingress
    // writes parties and activities into any tenant that can be named.
    name: "crm:ingress:submit",
    resource: "crm:ingress",
    action: "submit",
    description: "Deliver a normalised inbound communication event into the CRM",
  },
]);
