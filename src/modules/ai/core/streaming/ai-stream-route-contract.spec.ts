import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { NO_TENANT_TRANSACTION } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { KbRagController } from "../controllers/kb-rag.controller";

const AI_MODULE_ROOT = join(__dirname, "..", "..");

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

    for (const file of listControllerFiles(AI_MODULE_ROOT)) {
      const source = readFileSync(file, "utf8");
      const routes = source.match(/@(?:Post|Get)\("[^"]*stream[^"]*"\)/g) ?? [];
      if (routes.length === 0) continue;
      streamRoutes += routes.length;
      const usesHelper =
        source.includes("respondWithAiTextStream") || source.includes("pipeAiTextStream");
      if (!usesHelper) offenders.push(file);
    }

    expect(offenders).toEqual([]);
    expect(streamRoutes).toBeGreaterThanOrEqual(11);
  });

  it("no AI controller pipes the provider stream itself, bypassing the awaited pipe", () => {
    const offenders = listControllerFiles(AI_MODULE_ROOT).filter((file) =>
      /\.pipeTextStreamToResponse\(/.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("the scan actually looks at controller files", () => {
    const files = listControllerFiles(AI_MODULE_ROOT);

    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.some((f) => f.endsWith("kb-rag.controller.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("chat-assistant.controller.ts"))).toBe(true);
  });
});
