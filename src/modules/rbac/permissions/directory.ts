import type { Permission } from "./types";

export const DIRECTORY_PERMISSIONS: Permission[] = [
  {
    name: "directory:people:view",
    resource: "directory:people",
    action: "view",
    description: "View the org people directory",
  },
  {
    name: "directory:people:create",
    resource: "directory:people",
    action: "create",
    description: "Add people to the org directory",
  },
  {
    name: "directory:people:update",
    resource: "directory:people",
    action: "update",
    description: "Update people records in the org directory",
  },
  {
    name: "directory:people:delete",
    resource: "directory:people",
    action: "delete",
    description: "Soft-delete people from the org directory",
  },
  {
    name: "workforce:workers:view",
    resource: "workforce:workers",
    action: "view",
    description: "View workforce worker records",
  },
  {
    name: "workforce:workers:manage",
    resource: "workforce:workers",
    action: "manage",
    description: "Create and update workforce worker records",
  },
  {
    name: "workforce:workers:terminate",
    resource: "workforce:workers",
    action: "terminate",
    description: "Terminate workforce workers",
  },
];
