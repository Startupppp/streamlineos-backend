import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * c18-02 regression guard. Two controllers declared
 * `DELETE /hr/recruitment/candidates/:candidateId/vault/:documentId`. Express matches in
 * registration order, so `HrModule` (app.module.ts:153) shadowed `StorageModule` (:173) and
 * `StorageVaultController.remove` was unreachable — a handler with a different permission key
 * and a different audit behaviour than the one actually serving the route.
 *
 * Nest reports nothing for this: both controllers instantiate, both routes register, and the
 * loser simply never receives a request. Only a declaration-level check finds it.
 *
 * A file may declare SEVERAL @Controller classes — `build/execution/iterations.controller.ts`
 * declares four. Reading one prefix per file and applying it to every route in that file
 * manufactured eleven collisions that did not exist; routes are segmented per @Controller.
 */

const CONTROLLER_ROOT = join(__dirname, "modules");

const CONTROLLER = /@Controller\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;
const HANDLER =
  /@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)([\s\S]*?)\n\s{2}(?:public\s+|private\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\(/g;

interface Route {
  method: string;
  path: string;
  handler: string;
  file: string;
}

function controllerFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) found.push(...controllerFiles(p));
    else if (p.endsWith(".controller.ts")) found.push(p);
  }
  return found;
}

function declaredRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of controllerFiles(CONTROLLER_ROOT)) {
    const src = readFileSync(file, "utf8");
    const marks: Array<{ at: number; base: string }> = [];
    CONTROLLER.lastIndex = 0;
    let c: RegExpExecArray | null;
    while ((c = CONTROLLER.exec(src)) !== null)
      marks.push({ at: c.index, base: (c[1] ?? c[2] ?? "").replace(/^\/+|\/+$/g, "") });

    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i];
      if (!mark) continue;
      const next = marks[i + 1];
      const segment = src.slice(mark.at, next ? next.at : src.length);
      HANDLER.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HANDLER.exec(segment)) !== null) {
        const between = m[4] ?? "";
        if (between.includes("@Get(") || between.includes("@Post(")) continue;
        const sub = (m[2] ?? m[3] ?? "").replace(/^\/+|\/+$/g, "");
        routes.push({
          method: (m[1] ?? "").toUpperCase(),
          path: "/" + [mark.base, sub].filter(Boolean).join("/"),
          handler: m[5] ?? "",
          file: file.split("\\").join("/"),
        });
      }
    }
  }
  return routes;
}

const normalise = (path: string): string => path.replace(/:[A-Za-z0-9_]+/g, ":param");

describe("controller route declarations", () => {
  const routes = declaredRoutes();

  it("finds the controller surface, so a broken scan cannot pass vacuously", () => {
    expect(routes.length).toBeGreaterThan(3000);
  });

  it("declares each method and path exactly once, so no handler is shadowed", () => {
    const byKey = new Map<string, Route[]>();
    for (const route of routes) {
      const key = `${route.method} ${normalise(route.path)}`;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(route);
      else byKey.set(key, [route]);
    }

    const collisions = [...byKey.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([key, group]) => `${key} — ${group.map((r) => `${r.file}#${r.handler}`).join(" vs ")}`);

    expect(collisions).toEqual([]);
  });
});
