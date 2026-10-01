import { definePermissions } from "./types";

export const PAYMENTS_PERMISSIONS = definePermissions([
  {
    name: "payments:providers:view",
    resource: "payments:providers",
    action: "view",
    description: "View configured payment providers and readiness",
    scopable: false,
  },
  {
    name: "payments:providers:manage",
    resource: "payments:providers",
    action: "manage",
    description: "Connect, configure, and disable payment providers",
    scopable: false,
  },
  {
    name: "payments:credentials:manage",
    resource: "payments:credentials",
    action: "manage",
    description: "Add, rotate, and disconnect provider credentials",
    scopable: false,
  },
  {
    name: "payments:webhooks:view",
    resource: "payments:webhooks",
    action: "view",
    description: "View webhook health and event history",
    scopable: false,
  },
  {
    name: "payments:webhooks:manage",
    resource: "payments:webhooks",
    action: "manage",
    description: "Generate, verify, and retry payment webhooks",
    scopable: false,
  },
  {
    name: "payments:test:run",
    resource: "payments:test",
    action: "run",
    description: "Run test transactions against a payment provider",
    scopable: false,
  },
  {
    name: "payments:live:activate",
    resource: "payments:live",
    action: "activate",
    description: "Activate live payment processing",
    scopable: false,
  },
  {
    name: "payments:manual-methods:manage",
    resource: "payments:manual-methods",
    action: "manage",
    description: "Configure manual/offline payment methods",
    scopable: false,
  },
  {
    name: "payments:audit:view",
    resource: "payments:audit",
    action: "view",
    description: "View payment provider audit log",
    scopable: false,
  },
]);
