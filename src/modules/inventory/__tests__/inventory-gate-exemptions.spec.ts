import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * T16 — the gate types inventory is NOT asked to carry, and the reasons, held
 * so they cannot outlive their cause.
 *
 * PRD §12.9 names twelve gate types and asks each for recorded evidence. T16
 * built two of the four that had none — `property`
 * (`stock-engine/__tests__/quantity.property.spec.ts` and
 * `available-formula-parity.db.spec.ts`) and `load`
 * (`pnpm load:drive:inventory`) — and confirmed the third, `accessibility`, had
 * been built by T18 the same day. This file is the fourth.
 *
 * ## Why `browser` is an exemption and not a gate
 *
 * Not because it is hard. Because everything an inventory browser gate would
 * have to assert needs **a running, authenticated application**, and nothing in
 * either repository can produce one without a human:
 *
 *  1. Every inventory route is behind the authenticated layout. A browser
 *     pointed at `/inventory` without a session is measuring a redirect to
 *     sign-in. There is no seeded login fixture, no session-minting script and
 *     no CI service that boots the Nest API and the Next app together — the
 *     one recorded procedure for it is a human minting a NextAuth cookie by
 *     hand.
 *  2. A gate only one laptop can run, by hand, is not recorded evidence. This
 *     programme has twice found a gate that passed while measuring nothing, and
 *     a third would be worse than an honest gap. §12.9 is better served by a
 *     named exemption than by a green tick nothing produced.
 *  3. What a real browser adds over what inventory now has is **layout and
 *     paint**. The accessibility half of that landed on 2026-09-05 as T18's
 *     `inventory-a11y.test.tsx` — 32 axe runs over 11 surfaces under jsdom. The
 *     layout half is already owned by frontend issue #45 (the 375px device run)
 *     and is blocked on a credential, not on a missing harness.
 *
 * ## The one claim in the PRD that this ticket corrects
 *
 * §12.9 said "No Playwright / Puppeteer / Cypress in either repo". Neither repo
 * *declares* one, which is the load-bearing half and is asserted below. But
 * `@playwright/test@1.59.1` does resolve in the frontend lockfile as an
 * optional peer of `next@16.3.0`, and a headless Chromium sits in the operator
 * cache on this host. So the blocker was never the browser binary. It is the
 * authenticated app, which is why fixing `browser-driver.mjs`'s two hard-coded
 * Windows paths — real, and explicitly out of T16's scope — would not by itself
 * give inventory a gate.
 *
 * ## What this file therefore asserts
 *
 * Every reason above that a machine can check. The day one stops being true —
 * a browser automation dependency is declared, the driver learns an inventory
 * route, or `browser:measure` is wired into a workflow — this fails, and the
 * exemption has to be argued again rather than inherited. It is not a browser
 * gate and does not pretend to be one.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DRIVER = join(REPO_ROOT, "src", "scripts", "browser-driver.mjs");
const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");

/** Anything that would make a real browser drivable from a test run. */
const BROWSER_AUTOMATION_PACKAGES = [
  "playwright",
  "@playwright/test",
  "puppeteer",
  "puppeteer-core",
  "cypress",
  "webdriverio",
  "selenium-webdriver",
];

function packageJson(): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
}

function workflowSources(): string[] {
  if (!existsSync(WORKFLOWS)) return [];
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(join(WORKFLOWS, f), "utf8"));
}

describe("T16 — the browser gate is an exemption, and these are the reasons it rests on", () => {
  it("the repository still declares no browser-automation dependency", () => {
    const pkg = packageJson();
    const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const found = BROWSER_AUTOMATION_PACKAGES.filter((name) => name in declared);
    expect(
      found.length === 0
        ? ""
        : `${found.join(", ")} is now a declared dependency, so a browser can be driven from a` +
            ` test run. Re-decide the §12.9 browser exemption rather than inheriting it.`,
    ).toBe("");
  });

  it("browser-driver.mjs still targets the application root and knows no inventory route", () => {
    const source = readFileSync(DRIVER, "utf8");
    expect(source).toContain('flag("url", "http://localhost:1000")');
    expect(source.toLowerCase()).not.toContain("/inventory");
  });

  it("browser:measure is still wired into no workflow", () => {
    const referencing = workflowSources().filter(
      (s) => s.includes("browser:measure") || s.includes("browser-driver"),
    );
    expect(
      referencing.length === 0
        ? ""
        : `${referencing.length} workflow(s) now run the browser driver. If inventory is among` +
            ` what they measure, §12.9's browser row is no longer an exemption.`,
    ).toBe("");
  });

  /**
   * ANTI-VACUITY. The three assertions above are satisfied by a repository that
   * has no browser driver at all, which is a different world from this one and
   * would want a different decision. So: the driver has to still be there, and
   * still be a real CDP driver rather than a stub, for the exemption's own
   * description of it to be true.
   */
  it("the driver this exemption describes still exists and is still real CDP", () => {
    expect(existsSync(DRIVER)).toBe(true);
    const source = readFileSync(DRIVER, "utf8");
    for (const marker of ["webSocketDebuggerUrl", "Page.navigate", "--headless=new", "BROWSER_CANDIDATES"])
      expect(source).toContain(marker);
  });
});
