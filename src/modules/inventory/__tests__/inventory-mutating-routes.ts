/**
 * T17 — the population of inventory commands, derived from the source.
 *
 * The check this feeds used to rest on `MUST_TAKE_A_KEY`, eighteen handler
 * names written down by hand. A hand list of *covered* things cannot fail when
 * something new arrives uncovered: it goes stale in silence, which is how
 * `quality/recalls.controller::create` came to post engine movements with no
 * key at all and was found only in review. So the population is walked out of
 * the controllers instead, and a route that nobody has classified is a failure
 * rather than an absence.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const INVENTORY_ROOT = join(__dirname, "..");

export function inventoryControllerPaths(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".controller.ts")) found.push(path);
    }
  };
  walk(INVENTORY_ROOT);
  return found.sort();
}

/** The text between the first `open` at or after `at` and its matching `close`. */
function balanced(source: string, at: number, open: string, close: string): string {
  const start = source.indexOf(open, at);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

const CONSTRUCTOR_FIELD =
  /(?:private|public|protected|readonly)\s+(?:readonly\s+)?([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/g;

function injectedFields(source: string, from: number): Map<string, string> {
  const at = source.indexOf("constructor", from);
  const fields = new Map<string, string>();
  if (at === -1) return fields;
  for (const m of balanced(source, at, "(", ")").matchAll(CONSTRUCTOR_FIELD))
    fields.set(m[1] ?? "", m[2] ?? "");
  return fields;
}

/** A method declared at class indentation. Nested code sits deeper, so this does not match it. */
const CLASS_METHOD = /\n {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z0-9_]+)\s*\(/g;

interface ServiceClass {
  /** Methods whose own signature declares an idempotency key — i.e. commands. */
  commandMethods: Set<string>;
}

/**
 * Every non-controller class in the module, and which of its methods are
 * commands.
 *
 * "Command" is read off the signature, not off the body: a method that declares
 * an `idempotencyKey` parameter is one that intends to be replay-safe, and the
 * only honest source for that value is the client's header. Reading the
 * signature rather than chasing `runIdempotent(` through the call graph is
 * deliberate — the claim is often two or three hops down (`postGrn` delegates
 * to `GrnPostService`, `dispatchTransfer` hands the key to the stock engine),
 * and a regex walk of that depth is exactly the kind of analysis that reports
 * green over code it never reached.
 */
function serviceClasses(): Map<string, ServiceClass> {
  const out = new Map<string, ServiceClass>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith(".ts")) continue;
      if (path.endsWith(".controller.ts") || path.endsWith(".spec.ts")) continue;
      if (path.includes("__tests__")) continue;

      const source = readFileSync(path, "utf8");
      for (const cls of source.matchAll(/export class ([A-Za-z0-9_]+)/g)) {
        const commandMethods = new Set<string>();
        for (const method of source.matchAll(CLASS_METHOD)) {
          const params = balanced(source, method.index + method[0].length - 1, "(", ")");
          if (/\bidempotencyKey\s*[?:]/.test(params)) commandMethods.add(method[1] ?? "");
        }
        out.set(cls[1] ?? "", { commandMethods });
      }
    }
  };
  walk(INVENTORY_ROOT);
  return out;
}

const MUTATING = /@(Post|Put|Patch|Delete)\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/g;
const HANDLER_SIGNATURE = /\n {2}(?:async )?([A-Za-z0-9_]+)\s*\(/g;
const SERVICE_CALL = /this\.([A-Za-z0-9_]+)\s*\.\s*([A-Za-z0-9_]+)\s*\(/g;

export interface MutatingRoute {
  /** `stock/inv-stock.controller.ts`, relative to `modules/inventory/`. */
  file: string;
  verb: "Post" | "Put" | "Patch" | "Delete";
  path: string;
  handler: string;
  /** `<file>::<handler>` — the id the classification is keyed on. */
  id: string;
  /** The handler declares `@IdempotencyKey()`, so the key reaches the service. */
  takesClientKey: boolean;
  /**
   * The handler carries `@Idempotent("name")`, so the global
   * `IdempotencyInterceptor` claims the key, stores the response and replays it.
   *
   * This is the second of the two real coverage mechanisms, and reading only the
   * first is how three fenced routes — `purchase-orders::create`,
   * `projects::create`, `projects::addRequirement` — came to be recorded as
   * duplicating on retry, each under a hand-written reason asserting a duplicate
   * the interceptor makes impossible.
   */
  carriesInterceptorFence: boolean;
  /** The command name the fence registers under, when there is one. */
  fenceCommand: string | null;
  /** Any service method the handler calls that is resolvable at all. */
  callsResolved: number;
  /** Service commands (`Class.method`) the handler calls that declare an idempotency key. */
  commands: string[];
}

export function mutatingInventoryRoutes(): MutatingRoute[] {
  const services = serviceClasses();
  const routes: MutatingRoute[] = [];

  for (const path of inventoryControllerPaths()) {
    const source = readFileSync(path, "utf8");
    const file = path.slice(path.indexOf("modules/inventory/") + "modules/inventory/".length);
    const base = /@Controller\(\s*["'`]([^"'`]*)["'`]/.exec(source)?.[1] ?? "";
    const fields = injectedFields(source, 0);

    const signatures = [...source.matchAll(HANDLER_SIGNATURE)].map((m) => ({
      at: m.index,
      name: m[1] ?? "unknown",
      nameEnd: m.index + m[0].length - 1,
    }));

    for (const m of source.matchAll(MUTATING)) {
      const owner = signatures.find((s) => s.at > m.index);
      if (!owner) continue;
      const params = balanced(source, owner.nameEnd, "(", ")");
      const body = balanced(source, owner.nameEnd + params.length, "{", "}");

      const commands: string[] = [];
      let callsResolved = 0;
      for (const call of body.matchAll(SERVICE_CALL)) {
        const cls = fields.get(call[1] ?? "");
        if (!cls) continue;
        callsResolved++;
        if (services.get(cls)?.commandMethods.has(call[2] ?? ""))
          commands.push(`${cls}.${call[2]}`);
      }

      // The decorator run between the verb and the method name. `@Idempotent`
      // sits inside it by convention in every one of the thirteen live uses.
      const decorators = source.slice(m.index, owner.at);
      const fence = /@Idempotent\(\s*["'`]([^"'`]+)["'`]/.exec(decorators);

      const sub = m[2] ?? m[3] ?? "";
      routes.push({
        file,
        verb: (m[1] ?? "Post") as MutatingRoute["verb"],
        path: `${base}${sub ? `/${sub}` : ""}`,
        handler: owner.name,
        id: `${file}::${owner.name}`,
        takesClientKey: params.includes("@IdempotencyKey()"),
        carriesInterceptorFence: fence !== null,
        fenceCommand: fence?.[1] ?? null,
        callsResolved,
        commands,
      });
    }
  }
  return routes;
}

/**
 * Covered means a retry is answered rather than re-executed, by either mechanism:
 * the handler takes the client's key and hands it to a service that claims it, or
 * the handler is fenced and the global interceptor claims, stores and replays for
 * it. Both are real; a check that knows only one reports the other as broken.
 */
export function isCovered(route: MutatingRoute): boolean {
  return route.takesClientKey || route.carriesInterceptorFence;
}
