import type { Permission } from "./types";

export const ONBOARDING_PERMISSIONS: Permission[] = [
  {
    name: "onboarding:module-checklists:view",
    resource: "onboarding:module-checklists",
    action: "view",
    description: "View module setup checklists",
    scopable: false,
  },
  {
    name: "onboarding:module-checklists:manage",
    resource: "onboarding:module-checklists",
    action: "manage",
    description: "Complete, skip, and dismiss module setup checklist items",
    scopable: false,
  },
  {
    name: "onboarding:tours:view",
    resource: "onboarding:tours",
    action: "view",
    description: "View and progress guided tours",
    scopable: false,
  },
  {
    name: "hr:onboarding:tasks:view",
    resource: "hr:onboarding:tasks",
    action: "view",
    description: "View employee onboarding tasks",
    scopable: false,
  },
  {
    name: "hr:onboarding:tasks:complete",
    resource: "hr:onboarding:tasks",
    action: "complete",
    description: "Complete own or assigned employee onboarding tasks",
    scopable: false,
  },
];
