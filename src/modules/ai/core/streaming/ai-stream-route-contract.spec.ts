import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { NO_TENANT_TRANSACTION } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { KbRagController } from "../controllers/kb-rag.controller";

const AI_MODULE_ROOT = join(__dirname, "..", "..");

/**
 * The contract used to scan only `modules/ai`. Every streaming route lived
 * there, so the scan looked complete — but nothing stopped the next one being
 * added in the module that owns its data, and the gate would not have seen it.
 * The KB document surfaces are the first that are, so the scan is the whole
 * modules tree now and the AI-module-only assertions above it stay as the
 * narrower checks they always were.
 */
const MODULES_ROOT = join(__dirname, "..", "..", "..");

function listControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listControllerFiles(full));
      continue;
    }
    if (entry.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

function takesResponseObject(target: object, method: string): boolean {
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, method) as
    | Record<string, unknown>
    | undefined;
  if (!meta) return false;
  return Object.keys(meta).some((key) => key.startsWith(`${RouteParamtypes.RESPONSE}:`));
}

function optsOutOfTenantTransaction(controller: new (...args: never[]) => object, method: string): boolean {
  return (
    Reflect.getMetadata(NO_TENANT_TRANSACTION, controller.prototype[method] as object) === true ||
    Reflect.getMetadata(NO_TENANT_TRANSACTION, controller) === true
  );
}

describe("streaming routes must not run inside the request-scoped tenant transaction", () => {
  it("KbRagController.streamAsk takes the response object", () => {
    expect(takesResponseObject(KbRagController.prototype, "streamAsk")).toBe(true);
  });

  it("KbRagController opts out, so the transaction cannot commit while the stream is still producing", () => {
    expect(optsOutOfTenantTransaction(KbRagController, "streamAsk")).toBe(true);
  });

  it("every AI controller that hands a handler the raw response also opts out", () => {
    const offenders: string[] = [];

    for (const file of listControllerFiles(AI_MODULE_ROOT)) {
      const source = readFileSync(file, "utf8");
      if (!/@Res\(\)/.test(source)) continue;
      if (!/@NoTenantTransaction\(\)/.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  /**
   * This release removes duplicate mechanisms rather than adding them. A second
   * streaming path would compile, respond and look right while skipping the
   * abort seam, the awaited pipe and the HttpException passthrough that the
   * shared helper is the only place to get.
   */
  it("every streaming route goes through the one shared helper", () => {
    const offenders: string[] = [];
    let streamRoutes = 0;

    for (const file of listControllerFiles(MODULES_ROOT)) {
      const source = readFileSync(file, "utf8");
      const routes = source.match(/@(?:Post|Get)\("[^"]*stream[^"]*"\)/g) ?? [];
      if (routes.length === 0) continue;
      streamRoutes += routes.length;
      const usesHelper =
        source.includes("respondWithAiTextStream") ||
        source.includes("pipeAiTextStream") ||
        source.includes("pipeAiUiMessageStream");
      if (!usesHelper) offenders.push(file);
    }

    expect(offenders).toEqual([]);
    expect(streamRoutes).toBeGreaterThanOrEqual(19);
  });

  /**
   * A streaming handler that stays inside the request-scoped tenant transaction
   * commits it the instant it hands the stream off, while the provider is still
   * producing. The AI module gets this from a class-level opt-out; a streaming
   * route added in its own module must declare it per method.
   *
   * This reads the ROUTE's own decorator block, not the file. A file-level scan
   * passes as long as any sibling route carries the decorator, so deleting it
   * from one streaming handler in a controller that has four of them is
   * invisible — bite-proved, and that is exactly the shape this assertion had to
   * be rewritten out of.
   */
  it("every streaming route in the repo opts out of the tenant transaction, per route", () => {
    const offenders: string[] = [];

    for (const file of listControllerFiles(MODULES_ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n");
      const classAt = lines.findIndex((l) => /^export class /.test(l));
      const classLevel = lines
        .slice(0, classAt === -1 ? 0 : classAt)
        .some((l) => /@NoTenantTransaction\(\)/.test(l));

      lines.forEach((line, index) => {
        if (!/@(?:Post|Get)\("[^"]*stream[^"]*"\)/.test(line)) return;
        const block: string[] = [];
        for (let i = index; i < lines.length; i += 1) {
          const current = lines[i] ?? "";
          if (i > index && !/^\s*@/.test(current)) break;
          block.push(current);
        }
        const routeLevel = block.some((l) => /@NoTenantTransaction\(\)/.test(l));
        if (!routeLevel && !classLevel) offenders.push(`${file}:${String(index + 1)}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it("that per-route scan actually reaches every streaming route", () => {
    let seen = 0;
    for (const file of listControllerFiles(MODULES_ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n");
      seen += lines.filter((l) => /@(?:Post|Get)\("[^"]*stream[^"]*"\)/.test(l)).length;
    }

    expect(seen).toBeGreaterThanOrEqual(19);
  });

  it("the repo-wide scan reaches streaming routes outside modules/ai", () => {
    const outside = listControllerFiles(MODULES_ROOT)
      .filter((f) => !f.includes(`${sep}ai${sep}`))
      .filter((f) => /@(?:Post|Get)\("[^"]*stream[^"]*"\)/.test(readFileSync(f, "utf8")));

    expect(outside.some((f) => f.endsWith("kb-page-ai.controller.ts"))).toBe(true);
    expect(outside.some((f) => f.endsWith("kb-article-ai.controller.ts"))).toBe(true);
  });

  it("no AI controller pipes the provider stream itself, bypassing the awaited pipe", () => {
    const offenders = listControllerFiles(AI_MODULE_ROOT).filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        /\.pipeTextStreamToResponse\(/.test(source) ||
        /\.pipeUIMessageStreamToResponse\(/.test(source)
      );
    });

    expect(offenders).toEqual([]);
  });

  it("the scan actually looks at controller files", () => {
    const files = listControllerFiles(AI_MODULE_ROOT);

    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.some((f) => f.endsWith("kb-rag.controller.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("chat-assistant.controller.ts"))).toBe(true);
  });
});
