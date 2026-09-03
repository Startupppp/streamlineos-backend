import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AUTOMATION_TRIGGERS, type AutomationTriggerEvent } from "../../db/schema/automation/rules";
import {
  AUTOMATION_TRIGGER_MODULE,
  AUTOMATION_TRIGGER_MODULES,
  automationTriggersForModule,
  moduleForAutomationTrigger,
} from "./automation-trigger-modules";
import { createAutomationSchema } from "../settings/dto/settings.schemas";

/**
 * The trigger vocabulary is ONE list, and every trigger on it has exactly one
 * owning module.
 *
 * Before this gate the vocabulary existed three times and disagreed with itself:
 * the engine enum AUTOMATION_TRIGGERS held 55, the write schema restated 48 of
 * them by hand, and the frontend map covered 33 and ended `?? "hr"` — so 19 of
 * the 48 the API accepted resolved to HR, 15 by silent default and 4 by an
 * explicit entry. R-12 wants to pick an automation rule's permission rung from
 * its trigger, and a default rung is a wrong rung.
 *
 * Two things keep it true. AUTOMATION_TRIGGER_MODULE is
 * `Record<AutomationTriggerEvent, AutomationTriggerModule>`, so a trigger added
 * to the engine without an owner does not compile; that is the real gate, and
 * `pnpm check:spec-typecheck` is what runs it. This file is the runtime half:
 * it proves the derived schema did not drift, that no module value is dead, and
 * that nothing the engine actually dispatches is missing from the list.
 *
 * ANTI-VACUITY. Every scan here carries a floor. A regex that stops matching
 * reports "no problems found", and this repository has six confirmed instances
 * of exactly that. The floors are deliberately below the measured values so
 * ordinary growth does not trip them, and far enough above zero that a broken
 * scan cannot pass.
 */

const MEASURED_TRIGGER_FLOOR = 55;
const MEASURED_DISPATCH_SITE_FLOOR = 20;

const SRC_ROOT = resolve(__dirname, "..", "..");

function walkTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTypeScriptFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

interface DispatchSite {
  readonly trigger: string;
  readonly file: string;
}

function collectDispatchSites(): DispatchSite[] {
  const pattern = /runAutomationsForEvent\(\s*[A-Za-z0-9_.?\s]*,\s*"([a-z][a-z0-9_.]*)"/g;
  const sites: DispatchSite[] = [];
  for (const file of walkTypeScriptFiles(SRC_ROOT)) {
    if (file.endsWith(".spec.ts") || file.endsWith(".e2e-spec.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern))
      sites.push({ trigger: match[1] as string, file: file.slice(SRC_ROOT.length + 1) });
  }
  return sites;
}

describe("automation trigger vocabulary", () => {
  it("has one vocabulary, and the scan that reads it is not vacuous", () => {
    expect(AUTOMATION_TRIGGERS.length).toBeGreaterThanOrEqual(MEASURED_TRIGGER_FLOOR);
    expect(new Set(AUTOMATION_TRIGGERS).size).toBe(AUTOMATION_TRIGGERS.length);
  });

  it("gives every engine trigger exactly one owning module, with no default", () => {
    const owned = Object.keys(AUTOMATION_TRIGGER_MODULE);
    const missing = AUTOMATION_TRIGGERS.filter(
      (trigger) => !Object.prototype.hasOwnProperty.call(AUTOMATION_TRIGGER_MODULE, trigger),
    );
    const stray = owned.filter(
      (trigger) => !(AUTOMATION_TRIGGERS as readonly string[]).includes(trigger),
    );

    expect(missing).toEqual([]);
    expect(stray).toEqual([]);
    expect(owned.length).toBe(AUTOMATION_TRIGGERS.length);

    for (const trigger of AUTOMATION_TRIGGERS)
      expect(AUTOMATION_TRIGGER_MODULES).toContain(moduleForAutomationTrigger(trigger));
  });

  it("has no dead module value — every module owns at least one trigger", () => {
    for (const module of AUTOMATION_TRIGGER_MODULES)
      expect(automationTriggersForModule(module).length).toBeGreaterThan(0);

    const partitioned = AUTOMATION_TRIGGER_MODULES.reduce(
      (total, module) => total + automationTriggersForModule(module).length,
      0,
    );
    expect(partitioned).toBe(AUTOMATION_TRIGGERS.length);
  });

  it("accepts on the write API exactly what the engine dispatches — no more, no less", () => {
    for (const trigger of AUTOMATION_TRIGGERS) {
      const parsed = createAutomationSchema.safeParse({
        name: "rule",
        triggerEvent: trigger,
        actions: [{ type: "notify_all", config: { title: "t", message: "m" } }],
      });
      expect(parsed.success).toBe(true);
    }

    const rejected = createAutomationSchema.safeParse({
      name: "rule",
      triggerEvent: "not.a.real.trigger",
      actions: [{ type: "notify_all", config: { title: "t", message: "m" } }],
    });
    expect(rejected.success).toBe(false);
  });

  it("knows every trigger the engine is actually asked to dispatch", () => {
    const sites = collectDispatchSites();
    expect(sites.length).toBeGreaterThanOrEqual(MEASURED_DISPATCH_SITE_FLOOR);

    const unknown = sites.filter(
      (site) => !(AUTOMATION_TRIGGERS as readonly string[]).includes(site.trigger),
    );
    expect(unknown.map((site) => `${site.trigger} (${site.file})`)).toEqual([]);
  });

  it("keeps the owning module resolvable for every trigger a dispatch site names", () => {
    for (const site of collectDispatchSites()) {
      const module = moduleForAutomationTrigger(site.trigger as AutomationTriggerEvent);
      expect(AUTOMATION_TRIGGER_MODULES).toContain(module);
    }
  });
});
