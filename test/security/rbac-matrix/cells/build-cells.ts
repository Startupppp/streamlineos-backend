import { FilesController } from "src/modules/build/files/files.controller";
import { ProjectsTicketAssociationsController } from "src/modules/build/core/tickets/projects-ticket-associations.controller";
import { ProjectsCustomFieldsService, ProjectsWebhooksService } from "src/modules/build/core";
import { IntakeService, ViewsService } from "src/modules/build/execution/workspace.service";
import { ModulesService } from "src/modules/build/execution/modules.service";
import { createWebhookSchema } from "src/modules/build/core/dto/webhook.schemas";
import { createCustomFieldSchema } from "src/modules/build/core/dto/custom-fields.schemas";
import { createIntakeSchema, createViewSchema } from "src/modules/build/execution/dto/workspace.schemas";
import { createModuleSchema } from "src/modules/build/execution/dto/iterations.schemas";
import type { ExecutableCell } from "../matrix.types";
import { probeHttp } from "../adapters/http-adapter";
import { projectAccess, projectWrite, ticketRead } from "../adapters/service-adapter";
import { signedFileUrl } from "../adapters/file-adapter";
import { accessFor, actorFor, ORG_A, ORG_B, userOf } from "../standings";
import { standIn, type WorldDb } from "../world-db";
import { FILE_A, PROJECT_A, SIBLING_PROJECT_A, TICKET_A } from "../fixtures";

type Writer = (world: WorldDb, orgId: string) => Promise<unknown>;

const WRITERS: ReadonlyArray<{ readonly id: string; readonly route: string; readonly write: Writer }> = [
  {
    id: "webhooks",
    route: "POST /build/:projectId/webhooks",
    write: (world, orgId) =>
      new ProjectsWebhooksService(world.db).createWebhook(
        orgId,
        PROJECT_A,
        userOf("module:admin", orgId),
        createWebhookSchema.parse({ url: "https://hooks.example.com/build", events: ["ticket.created"] }),
      ),
  },
  {
    id: "custom-fields",
    route: "POST /build/:projectId/custom-fields",
    write: (world, orgId) =>
      new ProjectsCustomFieldsService(world.db, accessFor(world)).createField(
        orgId,
        PROJECT_A,
        createCustomFieldSchema.parse({ name: "Severity", type: "text" }),
      ),
  },
  {
    id: "intake",
    route: "POST /build/:projectId/intake",
    write: (world, orgId) =>
      new IntakeService(world.db, standIn({}), accessFor(world)).createIntake(
        actorFor("module:admin", orgId),
        PROJECT_A,
        createIntakeSchema.parse({ title: "Intake", submitterEmail: "intake@example.com" }),
      ),
  },
  {
    id: "views",
    route: "POST /build/:projectId/views",
    write: (world, orgId) =>
      new ViewsService(world.db, accessFor(world)).createView(
        actorFor("module:admin", orgId),
        PROJECT_A,
        createViewSchema.parse({ name: "Board" }),
      ),
  },
  {
    id: "modules",
    route: "POST /build/:projectId/modules",
    write: (world, orgId) =>
      new ModulesService(world.db).createModule(
        orgId,
        userOf("module:admin", orgId),
        PROJECT_A,
        createModuleSchema.parse({ name: "Payments" }),
      ),
  },
];

function writerCells(world: WorldDb): ExecutableCell[] {
  return WRITERS.flatMap((writer): ExecutableCell[] => [
    {
      kind: "executable",
      id: `build-${writer.id}-write-same-tenant`,
      standing: "module:admin",
      resource: `build:${writer.id}`,
      action: "create",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: `${writer.route} resolves the caller's own project and inserts`,
      run: () => projectWrite(world, ORG_A, (orgId) => writer.write(world, orgId)),
    },
    {
      kind: "executable",
      id: `build-${writer.id}-write-cross-tenant`,
      standing: "module:admin",
      resource: `build:${writer.id}`,
      action: "create",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "service",
      because: `${writer.route} resolves the project before inserting, so a foreign project id is not found and nothing is written`,
      pairedWith: `build-${writer.id}-write-same-tenant`,
      run: () => projectWrite(world, ORG_B, (orgId) => writer.write(world, orgId)),
    },
  ]);
}

function projectCells(world: WorldDb): ExecutableCell[] {
  return [
    {
      kind: "executable",
      id: "build-project-access-org-owner",
      standing: "org:owner",
      resource: "build:project",
      action: "access",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "the owner reaches its own project and the project is still looked up",
      run: () => projectAccess(world, "org:owner", ORG_A, PROJECT_A),
    },
    {
      kind: "executable",
      id: "build-project-access-org-owner-cross-tenant",
      standing: "org:owner",
      resource: "build:project",
      action: "access",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "service",
      because: "owner standing does not short-circuit the project lookup, so another organisation's project is not found",
      pairedWith: "build-project-access-org-owner",
      run: () => projectAccess(world, "org:owner", ORG_B, PROJECT_A),
    },
    {
      kind: "executable",
      id: "build-project-access-module-admin",
      standing: "module:admin",
      resource: "build:project",
      action: "access",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "the build module admin resolves build:manage",
      run: () => projectAccess(world, "module:admin", ORG_A, PROJECT_A),
    },
    {
      kind: "executable",
      id: "build-project-access-module-admin-cross-tenant",
      standing: "module:admin",
      resource: "build:project",
      action: "access",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "service",
      because: "build:manage does not short-circuit the project lookup either",
      pairedWith: "build-project-access-module-admin",
      run: () => projectAccess(world, "module:admin", ORG_B, PROJECT_A),
    },
    {
      kind: "executable",
      id: "build-project-access-module-member",
      standing: "module:member",
      resource: "build:project",
      action: "access",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "a project member reaches the project it belongs to",
      run: () => projectAccess(world, "module:member", ORG_A, PROJECT_A),
    },
    {
      kind: "executable",
      id: "build-project-access-org-member",
      standing: "org:member",
      resource: "build:project",
      action: "access",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "service",
      because: "an in-tenant member who is not on the project is forbidden, not told it is missing",
      pairedWith: "build-project-access-module-member",
      run: () => projectAccess(world, "org:member", ORG_A, PROJECT_A),
    },
  ];
}

function ticketCells(world: WorldDb): ExecutableCell[] {
  const subtasks = (standing: "org:member" | "module:member", moduleDisabled: boolean) => () =>
    probeHttp(world, {
      controllers: [ProjectsTicketAssociationsController],
      verb: "get",
      path: `/build/${PROJECT_A}/tickets/${TICKET_A}/subtasks`,
      permissionKey: "build:tickets:view",
      standing,
      orgId: ORG_A,
      moduleDisabled,
    });
  return [
    {
      kind: "executable",
      id: "build-ticket-read-module-member",
      standing: "module:member",
      resource: "build:ticket",
      action: "read",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "a project member reads a ticket nested under its own project",
      run: () => ticketRead(world, "module:member", ORG_A, PROJECT_A, TICKET_A),
    },
    {
      kind: "executable",
      id: "build-ticket-read-cross-project",
      standing: "module:member",
      resource: "build:ticket",
      action: "read",
      tenant: "same",
      state: "cross-project",
      expected: "404",
      adapter: "service",
      because: "a ticket addressed through a sibling project is bound to its parent and is not found",
      pairedWith: "build-ticket-read-module-member",
      run: () => ticketRead(world, "module:member", ORG_A, SIBLING_PROJECT_A, TICKET_A),
    },
    {
      kind: "executable",
      id: "build-ticket-read-cross-tenant",
      standing: "module:member",
      resource: "build:ticket",
      action: "read",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "service",
      because: "another organisation's ticket id is not found",
      pairedWith: "build-ticket-read-module-member",
      run: () => ticketRead(world, "module:member", ORG_B, PROJECT_A, TICKET_A),
    },
    {
      kind: "executable",
      id: "build-ticket-read-org-member",
      standing: "org:member",
      resource: "build:ticket",
      action: "read",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "service",
      because: "a member outside the project and without a tickets scope is forbidden",
      pairedWith: "build-ticket-read-module-member",
      run: () => ticketRead(world, "org:member", ORG_A, PROJECT_A, TICKET_A),
    },
    {
      kind: "executable",
      id: "build-ticket-subtasks-http-module-member",
      standing: "module:member",
      resource: "build:ticket",
      action: "list-subtasks",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "http",
      because: "the build module member rung holds build:tickets:view",
      run: subtasks("module:member", false),
    },
    {
      kind: "executable",
      id: "build-ticket-subtasks-http-org-member",
      standing: "org:member",
      resource: "build:ticket",
      action: "list-subtasks",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "http",
      because: "a plain member never resolves build:tickets:view",
      pairedWith: "build-ticket-subtasks-http-module-member",
      run: subtasks("org:member", false),
    },
    {
      kind: "executable",
      id: "build-ticket-subtasks-http-module-disabled",
      standing: "module:member",
      resource: "build:ticket",
      action: "list-subtasks",
      tenant: "same",
      state: "module-disabled",
      expected: "402",
      adapter: "http",
      because: "ModuleGuard refuses a disabled module with 402 before the permission is read",
      pairedWith: "build-ticket-subtasks-http-module-member",
      run: subtasks("module:member", true),
    },
  ];
}

function fileCells(world: WorldDb): ExecutableCell[] {
  const listFiles = (standing: "org:owner" | "org:member" | "module:member" | "module:admin", moduleDisabled: boolean) => () =>
    probeHttp(world, {
      controllers: [FilesController],
      verb: "get",
      path: `/build/${PROJECT_A}/files`,
      permissionKey: "build:files:view",
      standing,
      orgId: ORG_A,
      moduleDisabled,
    });
  const cell = (
    id: string,
    standing: ExecutableCell["standing"],
    state: ExecutableCell["state"],
    expected: ExecutableCell["expected"],
    because: string,
    run: ExecutableCell["run"],
    pairedWith?: string,
  ): ExecutableCell => ({
    kind: "executable",
    id,
    standing,
    resource: "build:files",
    action: "list",
    tenant: "same",
    state,
    expected,
    adapter: "http",
    because,
    pairedWith,
    run,
  });
  return [
    cell("build-files-http-module-admin", "module:admin", "normal", "allow", "the module admin holds build:files:view", listFiles("module:admin", false)),
    cell(
      "build-files-http-module-admin-module-disabled",
      "module:admin",
      "module-disabled",
      "402",
      "a disabled module is a plan answer, not a permission answer",
      listFiles("module:admin", true),
      "build-files-http-module-admin",
    ),
    cell("build-files-http-org-owner", "org:owner", "normal", "allow", "the owner holds every catalog key", listFiles("org:owner", false)),
    cell(
      "build-files-http-org-owner-module-disabled",
      "org:owner",
      "module-disabled",
      "402",
      "owner standing does not bypass the module gate",
      listFiles("org:owner", true),
      "build-files-http-org-owner",
    ),
    cell("build-files-http-module-member", "module:member", "normal", "allow", "the member rung holds view keys", listFiles("module:member", false)),
    cell(
      "build-files-http-org-member",
      "org:member",
      "normal",
      "403",
      "a plain member never resolves build:files:view",
      listFiles("org:member", false),
      "build-files-http-module-member",
    ),
    {
      kind: "executable",
      id: "file-signed-url-same-tenant",
      standing: "module:admin",
      resource: "build:file",
      action: "signed-url",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "file",
      because: "the caller's own file is signed under its own org prefix",
      run: () => signedFileUrl(world, "module:admin", ORG_A, PROJECT_A, FILE_A),
    },
    {
      kind: "executable",
      id: "file-signed-url-cross-tenant",
      standing: "module:admin",
      resource: "build:file",
      action: "signed-url",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "file",
      because: "another organisation's project is not found, so no URL is ever signed",
      pairedWith: "file-signed-url-same-tenant",
      run: () => signedFileUrl(world, "module:admin", ORG_B, PROJECT_A, FILE_A),
    },
    {
      kind: "executable",
      id: "file-signed-url-cross-project",
      standing: "module:admin",
      resource: "build:file",
      action: "signed-url",
      tenant: "same",
      state: "cross-project",
      expected: "404",
      adapter: "file",
      because: "a file addressed through a sibling project is bound to its parent and is not found",
      pairedWith: "file-signed-url-same-tenant",
      run: () => signedFileUrl(world, "module:admin", ORG_A, SIBLING_PROJECT_A, FILE_A),
    },
  ];
}

export function buildCells(world: WorldDb): ExecutableCell[] {
  return [...projectCells(world), ...writerCells(world), ...ticketCells(world), ...fileCells(world)];
}
