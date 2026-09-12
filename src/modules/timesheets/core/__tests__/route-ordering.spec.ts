import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * TS-11. A literal route must be declared before the `:param` route that would
 * otherwise swallow it.
 *
 * `GET /timesheets/periods/overdue` and `GET /timesheets/periods/:periodId` are
 * the same shape to a router, and Nest matches in declaration order. Put
 * `overdue` second and every request for the overdue queue reaches `getPeriod`
 * instead, where `ParseIntPipe` rejects the word "overdue" — a 400 that reads
 * like a client bug and is nothing of the kind.
 *
 * `periods.controller.ts` carries a comment saying so. A comment is not a
 * guard: the next person to add `@Get("summary")` will add it at the bottom of
 * the file, which is where handlers go, and nothing will complain until
 * somebody opens the page.
 *
 * Deliberately narrower than `app-route-uniqueness.spec.ts`, which normalises
 * every param to `:param` and so cannot see this at all — to it, `overdue` and
 * `:periodId` are two different paths, and they are, right up until one of them
 * is matched first. Measured across all 300+ controllers in `src/modules` at the
 * time of writing, this ordering error appears nowhere; that is worth keeping
 * true here, where the failure has a name and a ticket.
 */

const TIMESHEETS_ROOT = join(__dirname, "..", "..");

const CONTROLLER = /@Controller\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;
const HANDLER = /@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;

interface Declared {
  readonly method: string;
  readonly path: string;
  readonly base: string;
  readonly file: string;
}

function controllerFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) controllerFiles(full, found);
    else if (full.endsWith(".controller.ts")) found.push(full);
  }
  return found;
}

/**
 * Routes in declaration order, grouped by the `@Controller` they belong to.
 *
 * A file may hold more than one `@Controller`, so the routes are segmented at
 * each decorator rather than attributed to the first one — reading a single
 * prefix per file is what manufactured eleven phantom collisions in
 * `app-route-uniqueness.spec.ts` before it was fixed the same way.
 */
export function declaredRoutes(source: string, file: string): Declared[] {
  const marks: Array<{ at: number; base: string }> = [];
  CONTROLLER.lastIndex = 0;
  let controller: RegExpExecArray | null;
  while ((controller = CONTROLLER.exec(source)) !== null)
    marks.push({ at: controller.index, base: controller[1] ?? controller[2] ?? "" });

  const routes: Declared[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    if (!mark) continue;
    const next = marks[i + 1];
    const segment = source.slice(mark.at, next ? next.at : source.length);
    HANDLER.lastIndex = 0;
    let handler: RegExpExecArray | null;
    while ((handler = HANDLER.exec(segment)) !== null) {
      routes.push({
        method: (handler[1] ?? "").toUpperCase(),
        path: (handler[2] ?? handler[3] ?? "").replace(/^\/+|\/+$/g, ""),
        base: mark.base,
        file,
      });
    }
  }
  return routes;
}

const segments = (path: string): string[] => (path === "" ? [] : path.split("/"));

/**
 * Whether `earlier`, declared first, matches every request meant for `later`.
 *
 * True when the two have the same number of segments, differ only where
 * `earlier` holds a parameter and `later` holds a literal, and differ at least
 * once that way. Two literals must be identical; a parameter opposite a
 * parameter is the same route, which `app-route-uniqueness.spec.ts` already
 * owns.
 */
export function shadows(earlier: string, later: string): boolean {
  const a = segments(earlier);
  const b = segments(later);
  if (a.length !== b.length) return false;

  let swallowsALiteral = false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? "";
    const right = b[i] ?? "";
    const leftIsParam = left.startsWith(":");
    const rightIsParam = right.startsWith(":");
    if (leftIsParam && !rightIsParam) {
      swallowsALiteral = true;
      continue;
    }
    if (leftIsParam && rightIsParam) continue;
    if (!leftIsParam && !rightIsParam && left === right) continue;
    return false;
  }
  return swallowsALiteral;
}

function orderingFaults(): string[] {
  const faults: string[] = [];
  for (const file of controllerFiles(TIMESHEETS_ROOT)) {
    const routes = declaredRoutes(readFileSync(file, "utf8"), file);
    for (let i = 0; i < routes.length; i += 1) {
      for (let j = i + 1; j < routes.length; j += 1) {
        const earlier = routes[i];
        const later = routes[j];
        if (!earlier || !later) continue;
        if (earlier.method !== later.method) continue;
        if (earlier.base !== later.base) continue;
        if (!shadows(earlier.path, later.path)) continue;
        faults.push(
          `${file.split("/").slice(-2).join("/")}: ${earlier.method} "${earlier.base}/${earlier.path}" ` +
            `is declared before "${earlier.base}/${later.path}" and matches every request meant for it. ` +
            `Move the literal route above the parameter one.`,
        );
      }
    }
  }
  return faults;
}

describe("timesheets route declaration order", () => {
  it("reads the whole controller surface, so a broken walk cannot pass vacuously", () => {
    const routes = controllerFiles(TIMESHEETS_ROOT).flatMap((file) =>
      declaredRoutes(readFileSync(file, "utf8"), file),
    );
    expect(controllerFiles(TIMESHEETS_ROOT).length).toBeGreaterThanOrEqual(13);
    expect(routes.length).toBeGreaterThan(60);
  });

  it("finds the overdue queue, so this is watching the route the ticket is about", () => {
    const periods = join(TIMESHEETS_ROOT, "core", "periods.controller.ts");
    const routes = declaredRoutes(readFileSync(periods, "utf8"), periods);
    const overdue = routes.findIndex((r) => r.method === "GET" && r.path === "overdue");
    const byId = routes.findIndex((r) => r.method === "GET" && r.path === ":periodId");
    expect(overdue).toBeGreaterThanOrEqual(0);
    expect(byId).toBeGreaterThanOrEqual(0);
    expect(overdue).toBeLessThan(byId);
  });

  it("declares no literal route below a parameter route that would swallow it", () => {
    expect(orderingFaults()).toEqual([]);
  });

  it("detects the ordering it exists to prevent, so the check is proven to bite", () => {
    expect(shadows(":periodId", "overdue")).toBe(true);
    expect(shadows(":periodId/entries", "current/entries")).toBe(true);
    // The safe direction: a literal declared first shadows nothing.
    expect(shadows("overdue", ":periodId")).toBe(false);
    // Different depth, different route.
    expect(shadows(":periodId", "overdue/summary")).toBe(false);
    // Two literals that differ are simply two routes.
    expect(shadows("current", "overdue")).toBe(false);
    // Two parameters at the same position are the same route, owned elsewhere.
    expect(shadows(":periodId", ":id")).toBe(false);
  });
});
