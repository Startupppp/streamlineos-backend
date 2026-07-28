import type { Permission } from "./types";

export const SIGN_PERMISSIONS: Permission[] = [
  {
    name: "sign:documents:upload",
    resource: "sign:documents",
    action: "upload",
    description: "Upload documents to a SignOS envelope",
  },
  {
    name: "sign:documents:view",
    resource: "sign:documents",
    action: "view",
    description: "View SignOS documents",
  },
  {
    name: "sign:envelope:create",
    resource: "sign:envelope",
    action: "create",
    description: "Create and edit SignOS envelopes",
  },
  {
    name: "sign:envelope:view",
    resource: "sign:envelope",
    action: "view",
    description: "View SignOS envelopes you sent or were assigned",
  },
  {
    name: "sign:envelope:view_all",
    resource: "sign:envelope",
    action: "view_all",
    description: "View all SignOS envelopes in the organization",
  },
  {
    name: "sign:envelope:send",
    resource: "sign:envelope",
    action: "send",
    description: "Send and resend SignOS envelopes",
  },
  {
    name: "sign:envelope:void",
    resource: "sign:envelope",
    action: "void",
    description: "Void a sent SignOS envelope",
  },
  {
    name: "sign:envelope:correct",
    resource: "sign:envelope",
    action: "correct",
    description:
      "Correct recipients or extend expiration on a sent envelope",
  },
  {
    name: "sign:template:manage",
    resource: "sign:template",
    action: "manage",
    description: "Create, publish, and manage SignOS templates",
  },
  {
    name: "sign:bulk_send:run",
    resource: "sign:bulk_send",
    action: "run",
    description: "Run SignOS bulk send jobs",
  },
  {
    name: "sign:admin:manage",
    resource: "sign:admin",
    action: "manage",
    description:
      "Manage SignOS admin settings, branding, and watermark policy",
  },
  {
    name: "sign:audit:view",
    resource: "sign:audit",
    action: "view",
    description: "View the SignOS audit trail",
  },
  {
    name: "sign:certificate:download",
    resource: "sign:certificate",
    action: "download",
    description: "Download SignOS certificates and final signed PDFs",
  },
];
