import { definePermissions } from "./types";

export const STORAGE_PERMISSIONS = definePermissions([
  {
    name: "storage:quarantine:view",
    resource: "storage:quarantine",
    action: "view",
    description: "View file quarantine records and scan results",
  },
  {
    name: "storage:quarantine:manage",
    resource: "storage:quarantine",
    action: "manage",
    description: "Release, reject, retain and permanently delete quarantined files",
  },
  {
    name: "storage:files:manage",
    resource: "storage:files",
    action: "manage",
    description: "Initiate and complete presigned multipart uploads on behalf of the organization",
  },
]);
