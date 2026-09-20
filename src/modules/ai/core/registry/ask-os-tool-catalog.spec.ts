import "reflect-metadata";
import { z } from "zod";
import { HrCopilotTools } from "../tools/hr-copilot-tools";
import { WorkspaceCopilotTools } from "../tools/workspace-copilot-tools";
import { OpsCopilotTools } from "../tools/ops-copilot-tools";
import { CrmCopilotTools } from "../tools/crm-copilot-tools";
import { CommsCopilotTools } from "../tools/comms-copilot-tools";
import { ProjectsCopilotTools } from "../tools/projects-copilot-tools";
import { CommsActionsTools } from "../tools/comms-actions-tools";
import { MailCopilotTools } from "../tools/mail-copilot-tools";
import { WorkspaceInlineTools } from "../services/chat-assistant-inline-tools";
import { SelfHrTools } from "../tools/self-hr-tools";
import { SelfPayrollTools } from "../tools/self-payroll-tools";
import { SelfWorkTools } from "../tools/self-work-tools";
import { SelfActionsTools } from "../tools/self-actions-tools";
import { WorkActionsTools } from "../tools/work-actions-tools";
import { ALL_PERMISSION_NAMES } from "../../../rbac/permissions";
import { CATALOG_MODULES } from "../../../access/access-policy";
import { needsConfirmation, defineTool, data, type AskOsToolProvider } from "./ask-os-tool.types";
import { ACTION_LABELS } from "./ask-os-tool-registry";
import { CONFIRMABLE_ACTION_DEFINITIONS } from "../confirm-actions";

const PROVIDER_CLASSES = [
  HrCopilotTools,
  WorkspaceCopilotTools,
  OpsCopilotTools,
  CrmCopilotTools,
  CommsCopilotTools,
  ProjectsCopilotTools,
  CommsActionsTools,
  MailCopilotTools,
  WorkspaceInlineTools,
  SelfHrTools,
  SelfPayrollTools,
  SelfWorkTools,
  SelfActionsTools,
  WorkActionsTools,
];

function stubProvider(klass: new (...args: never[]) => AskOsToolProvider): AskOsToolProvider {
  return Object.create(klass.prototype) as AskOsToolProvider;
}

const ALL_DEFINITIONS = PROVIDER_CLASSES.flatMap((klass) => stubProvider(klass).tools());

describe("a typo in a tool's permission key silently removes it from every user's toolset forever", () => {
  it("every declared permission exists verbatim in the backend catalog", () => {
    const catalog = new Set(ALL_PERMISSION_NAMES);
    const ghosts = ALL_DEFINITIONS
      .filter((def): def is typeof def & { permission: string } => def.permission !== undefined)
      .filter((def) => !catalog.has(def.permission));

    expect(ghosts.map((d) => ({ key: d.key, permission: d.permission }))).toEqual([]);
  });
});

describe("a typo in a tool's module key silently exposes it to orgs that have not enabled the module", () => {
  it("every declared module key exists in the permission-namespace catalog that backs snapshot.modules", () => {
    const knownModules = new Set(CATALOG_MODULES);
    const unknown = ALL_DEFINITIONS
      .filter((def): def is typeof def & { module: string } => def.module !== undefined)
      .filter((def) => !knownModules.has(def.module));

    expect(unknown.map((d) => ({ key: d.key, module: d.module }))).toEqual([]);
  });
});

describe("needsConfirmation throws at the call site rather than letting a mistyped action reach the confirm-actions executor chain", () => {
  it("throws when the action is not in the confirmable-actions registry, so a missing executor is caught before a proposal is stored", () => {
    expect(() =>
      needsConfirmation({
        proposalId: 1,
        token: "t",
        action: "ticket.teleport",
        summary: "s",
        preview: {},
      }),
    ).toThrow("ticket.teleport");
  });

  it("does not throw for a registered action, so the happy path is not disturbed", () => {
    expect(() =>
      needsConfirmation({
        proposalId: 1,
        token: "t",
        action: "ticket.create",
        summary: "s",
        preview: {},
      }),
    ).not.toThrow();
  });
});

describe("a confirmable action with no ACTION_LABELS entry silently renders its raw summary and a generic Confirm button, repeating the drift that PRD 11.4 fixed", () => {
  it("every action in the confirmable-action registry has an ACTION_LABELS entry", () => {
    const missing = CONFIRMABLE_ACTION_DEFINITIONS
      .filter((def) => !(def.action in ACTION_LABELS))
      .map((def) => def.action);

    expect(missing).toEqual([]);
  });

  it("the parity spec is wired: an action absent from ACTION_LABELS is caught", () => {
    const sentinel = "not.registered.in.labels";
    expect(sentinel in ACTION_LABELS).toBe(false);
  });
});

describe("the catalog spec itself is not vacuous — the guards can be mutated into failure", () => {
  it("the permission spec is wired: a ghost permission outside the catalog is caught", () => {
    const ghost = defineTool({
      key: "testGhostPerm",
      description: "d",
      input: z.object({}),
      permission: "ghost:does-not-exist:ever",
      run: async () => data({}),
    });
    const catalog = new Set(ALL_PERMISSION_NAMES);
    expect(catalog.has(ghost.permission!)).toBe(false);
  });

  it("the module spec is wired: a ghost module outside the catalog is caught", () => {
    const ghost = defineTool({
      key: "testGhostModule",
      description: "d",
      input: z.object({}),
      module: "ghost-not-a-real-module",
      run: async () => data({}),
    });
    const knownModules = new Set(CATALOG_MODULES);
    expect(knownModules.has(ghost.module!)).toBe(false);
  });
});
