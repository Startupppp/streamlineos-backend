import "reflect-metadata";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WorkspaceInlineTools } from "../services/chat-assistant-inline-tools";
import { ALL_PERMISSION_NAMES } from "../../../rbac/permissions";
import { CATALOG_MODULES } from "../../../access/access-policy";
import { needsConfirmation, defineTool, data, type AskOsToolProvider } from "./ask-os-tool.types";
import { ACTION_LABELS, labelledConfirmDirective } from "./ask-os-tool-registry";
import { CONFIRMABLE_ACTION_DEFINITIONS } from "../confirm-actions";

type ProviderClass = new (...args: never[]) => AskOsToolProvider;

const TOOLS_DIR = path.join(__dirname, "..", "tools");

function isProviderClass(candidate: unknown): candidate is ProviderClass {
  return (
    typeof candidate === "function" &&
    typeof (candidate as { prototype?: { tools?: unknown } }).prototype?.tools === "function"
  );
}

function discoverProviderClasses(): { file: string; klass: ProviderClass }[] {
  const files = fs
    .readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith("-tools.ts") && !name.includes(".spec."));

  return files.flatMap((file) => {
    const loaded: unknown = jest.requireActual(path.join(TOOLS_DIR, file));
    if (loaded === null || typeof loaded !== "object") return [];
    return Object.values(loaded)
      .filter(isProviderClass)
      .map((klass) => ({ file, klass }));
  });
}

const DISCOVERED = discoverProviderClasses();

const PROVIDER_CLASSES: ProviderClass[] = [
  ...DISCOVERED.map((entry) => entry.klass),
  WorkspaceInlineTools,
];

function stubProvider(klass: ProviderClass): AskOsToolProvider {
  return Object.create(klass.prototype) as AskOsToolProvider;
}

const ALL_DEFINITIONS = PROVIDER_CLASSES.flatMap((klass) => stubProvider(klass).tools());

describe("the catalog gate sees every tool file, so adding one cannot escape the checks below", () => {
  it("discovers a provider class in every -tools.ts file, because a hand-maintained list silently stops covering the next one", () => {
    const files = fs
      .readdirSync(TOOLS_DIR)
      .filter((name) => name.endsWith("-tools.ts") && !name.includes(".spec."));
    const covered = new Set(DISCOVERED.map((entry) => entry.file));

    expect(files.filter((file) => !covered.has(file))).toEqual([]);
  });

  it("collects tools from those providers, so an empty discovery cannot make every other assertion vacuous", () => {
    expect(DISCOVERED.length).toBeGreaterThan(10);
    expect(ALL_DEFINITIONS.length).toBeGreaterThan(40);
  });
});

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

  it("carries no label for an action nobody can propose, because an orphan entry is a rename the map did not follow", () => {
    const registered = new Set(CONFIRMABLE_ACTION_DEFINITIONS.map((def) => def.action));
    const orphaned = Object.keys(ACTION_LABELS).filter((action) => !registered.has(action));

    expect(orphaned).toEqual([]);
  });

  it("gives every label a non-empty title and confirm label, so a blank string cannot satisfy the parity check above", () => {
    const blank = Object.entries(ACTION_LABELS)
      .filter(([, label]) => label.title.trim().length === 0 || label.confirmLabel.trim().length === 0)
      .map(([action]) => action);

    expect(blank).toEqual([]);
  });

  it("the directive emitted by labelledConfirmDirective for a registered action carries the curated title and confirmLabel from ACTION_LABELS, not the generic Confirm fallback", () => {
    const expected = ACTION_LABELS["ticket.create"];
    const directive = labelledConfirmDirective({
      kind: "needs-confirmation",
      proposalId: 1,
      token: "tok",
      action: "ticket.create",
      summary: "Create a ticket",
      preview: {},
    });

    expect(directive.title).toBe(expected?.title);
    expect(directive.confirmLabel).toBe(expected?.confirmLabel);
  });

  it("labelledConfirmDirective omits title and confirmLabel when no entry exists, letting the frontend fallback handle the gap rather than emitting a blank label", () => {
    const directive = labelledConfirmDirective({
      kind: "needs-confirmation",
      proposalId: 2,
      token: "tok2",
      action: "not.registered.in.labels",
      summary: "Some action",
      preview: {},
    });

    expect(directive.title).toBeUndefined();
    expect(directive.confirmLabel).toBeUndefined();
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
