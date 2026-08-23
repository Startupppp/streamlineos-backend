import path from "path";
import { Injectable, type OnModuleInit } from "@nestjs/common";
import {
  RELEASE_SYNC,
  newQuickJSWASMModuleFromVariant,
  isFail,
  shouldInterruptAfterDeadline,
  type QuickJSSyncVariant,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { z } from "zod";
import {
  mergedPayload,
  type NodeExecutionContext,
  type NodeExecutionInput,
  type NodeOutcome,
  type WorkflowNodeExecutor,
} from "../node-outcome";
import type { WorkflowGraphNode } from "../workflow-graph";

const MAX_CODE_LENGTH = 50_000;
const MAX_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1_024 * 1_024;

const scriptConfigSchema = z
  .object({
    code: z.string().min(1).max(MAX_CODE_LENGTH),
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
    outputVariable: z.string().min(1).max(64).optional(),
  })
  .strict();

type ScriptConfig = z.infer<typeof scriptConfigSchema>;

function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "invalid configuration";
  const p = issue.path.join(".");
  return p ? `${p}: ${issue.message}` : issue.message;
}

function extractErrorMessage(dumped: unknown): string {
  if (typeof dumped === "string") return dumped;
  if (
    typeof dumped === "object" &&
    dumped !== null &&
    "message" in dumped &&
    typeof dumped.message === "string"
  ) {
    const name =
      "name" in dumped && typeof dumped.name === "string"
        ? dumped.name
        : "Error";
    return `${name}: ${dumped.message}`;
  }
  return "Script execution error";
}

function buildOutput(
  dumped: unknown,
  outputVariable: string | undefined,
): NodeOutcome {
  const key = outputVariable ?? "result";
  const output: Record<string, unknown> = { [key]: dumped };
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    return {
      kind: "failed",
      error: "Script returned a non-JSON-serialisable value",
    };
  }
  if (serialized.length > MAX_OUTPUT_BYTES)
    return {
      kind: "failed",
      error: `Script output exceeds the ${MAX_OUTPUT_BYTES.toLocaleString()}-byte limit`,
    };
  return { kind: "continue", output };
}

function extractResultValue(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  outputVariable: string | undefined,
): NodeOutcome {
  const valueType = ctx.typeof(handle);

  if (valueType === "function" || valueType === "symbol") {
    handle.dispose();
    return { kind: "failed", error: "Script returned a non-JSON-serialisable value" };
  }

  if (valueType === "object") {
    const ps = ctx.getPromiseState(handle);
    if (ps.type === "rejected" || ps.type === "pending" || !ps.notAPromise) {
      if (ps.type === "rejected") ps.error.dispose();
      if (ps.type === "fulfilled") ps.value.dispose();
      handle.dispose();
      return { kind: "failed", error: "Script returned a non-JSON-serialisable value" };
    }
  }

  const dumped: unknown = ctx.dump(handle);
  if (handle.alive) handle.dispose();
  return buildOutput(dumped, outputVariable);
}

@Injectable()
export class WorkflowScriptExecutor
  implements WorkflowNodeExecutor, OnModuleInit
{
  private quickJS: QuickJSWASMModule | undefined;

  async onModuleInit(): Promise<void> {
    // Build a CJS-compatible variant: importFFI is already CJS-safe; replace
    // importModuleLoader with require() so that Jest (which rejects ESM import()
    // from pre-compiled node_modules) and production Node.js both work.
    const qjsDir = path.dirname(require.resolve("quickjs-emscripten"));
    const emscriptenPath = require.resolve(
      "@jitl/quickjs-wasmfile-release-sync/emscripten-module",
      { paths: [qjsDir] },
    );
    const cjsVariant: QuickJSSyncVariant = {
      type: "sync",
      importFFI: RELEASE_SYNC.importFFI,
      importModuleLoader: () => Promise.resolve(require(emscriptenPath)),
    };
    this.quickJS = await newQuickJSWASMModuleFromVariant(cjsVariant);
  }

  async execute(
    node: WorkflowGraphNode,
    input: NodeExecutionInput,
    _now: Date,
    _context: NodeExecutionContext,
  ): Promise<NodeOutcome> {
    if (!this.quickJS)
      return { kind: "failed", error: "Script runtime is not initialised" };

    const parsed = scriptConfigSchema.safeParse(node.data.configuration ?? {});
    if (!parsed.success)
      return {
        kind: "failed",
        error: `Script node is misconfigured (${firstIssue(parsed.error)})`,
      };

    const config: ScriptConfig = parsed.data;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const payload = mergedPayload(input);
    const payloadJsonLiteral = JSON.stringify(JSON.stringify(payload));

    const wrapped = `(function(){var payload=JSON.parse(${payloadJsonLiteral});return(function(){\n${config.code}\n})()})();`;

    const runtime = this.quickJS.newRuntime();
    try {
      runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
      runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + timeoutMs),
      );
      const ctx = runtime.newContext();
      try {
        const result = ctx.evalCode(wrapped, "script.js");
        if (isFail(result)) {
          const dumped: unknown = ctx.dump(result.error);
          if (result.error.alive) result.error.dispose();
          return { kind: "failed", error: extractErrorMessage(dumped) };
        }
        return extractResultValue(ctx, result.value, config.outputVariable);
      } finally {
        ctx.dispose();
      }
    } finally {
      runtime.dispose();
    }
  }
}
