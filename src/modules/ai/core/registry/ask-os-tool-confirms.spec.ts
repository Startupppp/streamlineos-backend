import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { data, defineTool } from "./ask-os-tool.types";
import { CONFIRM_ACTION_PERMISSION } from "../confirm-actions";

const TOOLS_ROOT = join(__dirname, "..");

function toolSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "confirm-actions" || entry === "__tests__") continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...toolSourceFiles(full));
      continue;
    }
    if (entry.endsWith("-tools.ts")) found.push(full);
  }
  return found;
}

const BASE = {
  key: "probe",
  description: "probe",
  input: z.object({}),
  run: async () => data({ ok: true }),
};

describe("a tool that proposes a confirmable action takes that action's permission rather than restating it", () => {
  it("derives the permission from the action, so the entry gate and the execution gate cannot drift apart", () => {
    const definition = defineTool({ ...BASE, confirms: "ticket.create" });

    expect(definition.permission).toBe(CONFIRM_ACTION_PERMISSION["ticket.create"]);
    expect(definition.permission).toBe("build:tickets:create");
  });

  it("throws at module load for an action no definition owns, rather than shipping a tool with no permission at all", () => {
    expect(() => defineTool({ ...BASE, confirms: "ticket.teleport" })).toThrow(
      /not a registered confirmable action/,
    );
  });

  it("leaves a read-only tool's own declared permission alone, because most tools propose nothing", () => {
    expect(defineTool({ ...BASE, permission: "build:tickets:view" }).permission).toBe(
      "build:tickets:view",
    );
  });

  it("leaves no tool restating a permission its action already owns, which is the drift this declaration exists to prevent", () => {
    const files = toolSourceFiles(TOOLS_ROOT);
    const restating = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return /confirms: "[^"]+",\s*\n\s*permission: "/.test(source);
    });

    expect(files.length).toBeGreaterThan(5);
    expect(restating).toEqual([]);
  });

  it("declares the same action each tool actually proposes, so the entry gate cannot name one action while the body raises another", () => {
    const mismatched: string[] = [];
    for (const file of toolSourceFiles(TOOLS_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/confirms: "([^"]+)",/g)) {
        const declared = match[1];
        if (declared === undefined) continue;
        const body = source.slice(match.index, match.index + 4_000);
        if (!body.includes(`action: "${declared}"`)) mismatched.push(`${file} :: ${declared}`);
      }
    }

    expect(mismatched).toEqual([]);
  });

  it("covers every registered action, so no action is left without a derivable permission", () => {
    const actionsWithoutPermission = Object.entries(CONFIRM_ACTION_PERMISSION)
      .filter(([, permission]) => !permission)
      .map(([action]) => action);

    expect(Object.keys(CONFIRM_ACTION_PERMISSION).length).toBeGreaterThan(20);
    expect(actionsWithoutPermission).toEqual([]);
  });
});
