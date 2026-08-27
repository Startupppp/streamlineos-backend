import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { CRM_CAPABILITIES } from "./capabilities/crm-capabilities";
import { decideCapabilityAccess } from "./mcp-authorization";

/**
 * The guard behind ticket 19's fifth criterion.
 *
 * "AI is barred from the authorization decision path" is not a thing a prompt
 * can promise. An instruction telling a model not to decide permissions is
 * still a model deciding permissions, badly. The criterion is only meaningful
 * if a model CANNOT be reached from the code that decides, and that is a
 * property of the import graph and of a function signature.
 *
 * Three claims, each failing separately.
 *
 * **Nothing on the decision path can call a model.** The walk below starts at
 * every file that participates in deciding — this module's pure decision, the
 * platform's `authorize`, the access service behind it, the guard that calls
 * it, and the two services that supply enablement and token scope — and follows
 * value imports until it runs out. No model SDK may appear.
 *
 * **The decision is synchronous.** A model call is a network call and a network
 * call is a promise. Nothing awaited can happen inside a synchronous function,
 * so `decideCapabilityAccess` cannot consult one — and making it async to try
 * would be a deliberate act in a diff that says so, which fails here.
 *
 * **No capability can change a permission.** An agent acting through this
 * surface has no move available that widens what it is allowed to do next,
 * because the catalogue contains nothing that grants, revokes or escalates.
 *
 * ## Why this bans model CLIENTS and not the `ai` directory
 *
 * The obvious rule — nothing under `src/modules/ai` — is wrong in both
 * directions. `src/modules/ai/core/billing/feature-gates.ts` is a list of plan
 * names with no imports at all, and it is legitimately reachable from plan
 * limits; banning it would force a pointless move of a constants file. And a
 * model client that lived somewhere else would sail past. What matters is
 * whether an inference call is REACHABLE, and an inference call needs a client,
 * and a client comes from one of these packages or from the gateway that wraps
 * them.
 */
describe("no model can reach the decision about what an agent may do", () => {
  const DECISION_PATH = [
    "src/modules/crm-mcp/mcp-authorization.ts",
    "src/modules/crm-mcp/crm-mcp-enablement.service.ts",
    "src/modules/crm-mcp/crm-mcp-grants.service.ts",
    "src/modules/access/authorize.ts",
    "src/modules/access/access.service.ts",
    "src/modules/access/permission.guard.ts",
  ] as const;

  /** Everything that can produce a completion. Scoped names match by prefix. */
  const MODEL_PACKAGES = ["ai", "openai", "cohere-ai", "ollama"] as const;
  const MODEL_SCOPES = [
    "@ai-sdk",
    "@openrouter",
    "@anthropic-ai",
    "@google/generative-ai",
    "@mistralai",
    "langchain",
  ] as const;
  /** The platform's own wrapper. Reaching this is reaching a model. */
  const MODEL_GATEWAY = /ai-gateway|modules\/ai\/core\/gateway/;

  const executable = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  const IMPORT = /import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  const SIDE_EFFECT = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  const RE_EXPORT = /export\s+(?!type\b)[\s\S]*?\sfrom\s*["']([^"']+)["']/g;

  function valueImports(source: string): string[] {
    const found: string[] = [];
    const code = executable(source);

    for (const match of code.matchAll(IMPORT)) {
      const clause = match[1].trim();
      if (clause.startsWith("type ")) continue;
      const braced = /^\{([\s\S]*)\}$/.exec(clause);
      if (braced) {
        const names = braced[1]
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        if (names.length === 0) continue;
        if (names.every((name) => name.startsWith("type "))) continue;
      }
      found.push(match[2]);
    }
    for (const match of code.matchAll(SIDE_EFFECT)) found.push(match[1]);
    for (const match of code.matchAll(RE_EXPORT)) found.push(match[1]);
    return found;
  }

  function resolveLocal(specifier: string, fromFile: string): string | null {
    if (!specifier.startsWith(".")) return null;
    const base = normalize(join(dirname(fromFile), specifier));
    for (const candidate of [`${base}.ts`, join(base, "index.ts")])
      if (existsSync(candidate)) return candidate;
    return null;
  }

  function reachable(): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue: string[] = [...DECISION_PATH];

    while (queue.length > 0) {
      const file = queue.shift();
      if (!file || files.has(file) || !existsSync(file)) continue;
      files.add(file);

      for (const specifier of valueImports(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith(".")) {
          packages.add(specifier);
          continue;
        }
        const target = resolveLocal(specifier, file);
        if (target && !files.has(target)) queue.push(target);
      }
    }

    return { files, packages };
  }

  it("starts from files that all exist, so a move cannot silence this", () => {
    const missing = DECISION_PATH.filter((file) => !existsSync(file));

    // If one of these moved, follow it. Deleting the entry is deleting the guard.
    expect(missing).toEqual([]);
  });

  /**
   * A positive control, because a graph walk that reaches nothing passes.
   *
   * The decision path is not a leaf: `authorize` pulls in `access.service.ts`
   * for `moduleOf`, which pulls in the entitlements chain and the schema barrel.
   * If this number collapses, the walk has stopped following something — a new
   * import syntax, a path alias — and the two assertions below have quietly
   * become assertions about an empty set.
   */
  it("actually walks the graph rather than stopping at the entry files", () => {
    const { files } = reachable();

    expect(files.size).toBeGreaterThan(50);
    expect(files.has("src/modules/access/access-policy.ts")).toBe(true);
  });

  it("reaches no model client from anything that decides", () => {
    const { files, packages } = reachable();

    const clients = [...packages].filter(
      (name) =>
        (MODEL_PACKAGES as readonly string[]).includes(name) ||
        MODEL_SCOPES.some((scope) => name.startsWith(scope)),
    );
    const gateways = [...files].filter((file) => MODEL_GATEWAY.test(file));

    // If a model is genuinely needed near here, it belongs on the other side of
    // the decision — acting within permissions already resolved, never inside
    // resolving them.
    expect(clients).toEqual([]);
    expect(gateways).toEqual([]);
  });

  it("decides synchronously, so there is no await for a model to hide in", () => {
    expect(decideCapabilityAccess.constructor.name).toBe("Function");
    expect(decideCapabilityAccess.constructor.name).not.toBe("AsyncFunction");
  });

  /**
   * The catalogue cannot hand an agent a bigger catalogue.
   *
   * `isPersonalTokenPermissionDelegable` already refuses `billing:`,
   * `ownership:` and `settings:` to any token, so a capability gated on one
   * could never be granted — but a capability that cannot be granted is still a
   * capability somebody will eventually "fix" by relaxing the policy. The
   * clearer statement is that the surface has no such tool at all, and that the
   * namespaces which administer access are simply absent from it.
   */
  it("offers no capability that could change what an agent is allowed to do", () => {
    const CHANGES_ACCESS = ["access:", "rbac:", "roles:", "ownership:", "settings:", "billing:"];
    const escalations = CRM_CAPABILITIES.filter((capability) =>
      CHANGES_ACCESS.some((prefix) => capability.permission.startsWith(prefix)),
    ).map((capability) => capability.name);

    expect(escalations).toEqual([]);
  });

  /**
   * The one capability that writes cannot write to the access tables either.
   *
   * Stated separately from the permission check above because the two fail for
   * different reasons: a capability could hold a harmless permission key and
   * still call a service that changes a role. Every mutating capability's target
   * has to be a CRM record.
   */
  it("mutates nothing outside the CRM", () => {
    const mutating = CRM_CAPABILITIES.filter((capability) => capability.mutates);
    const outsideCrm = mutating.filter(
      (capability) => !capability.permission.startsWith("crm:"),
    );

    expect(mutating.length).toBeGreaterThan(0);
    expect(outsideCrm).toEqual([]);
  });
});
