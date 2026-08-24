import { Injectable } from "@nestjs/common";
import { z } from "zod";
import type { WorkflowGraphNode } from "../workflow-graph";
import {
  mergedPayload,
  type NodeExecutionContext,
  type NodeExecutionInput,
  type NodeOutcome,
  type WorkflowNodeExecutor,
} from "../node-outcome";

export const LOOP_HARD_MAX_ITERATIONS = 1000;

const loopConfigSchema = z.object({
  itemsPath: z.string().min(1),
  itemVariable: z.string().default("item"),
  indexVariable: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
});

const loopStateSchema = z.object({
  items: z.array(z.unknown()),
  index: z.number().int().nonnegative(),
});

type LoopState = z.infer<typeof loopStateSchema>;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid configuration";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveDotPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

@Injectable()
export class WorkflowLoopExecutor implements WorkflowNodeExecutor {
  async execute(
    node: WorkflowGraphNode,
    input: NodeExecutionInput,
    _now: Date,
    _context: NodeExecutionContext,
  ): Promise<NodeOutcome> {
    const parsed = loopConfigSchema.safeParse(node.data.configuration ?? {});
    if (!parsed.success)
      return {
        kind: "failed",
        error: `Loop node is misconfigured (${firstIssue(parsed.error)})`,
      };

    const config = parsed.data;
    const stateKey = `__loop_${node.id}`;
    const effectiveMax = Math.min(
      config.maxIterations ?? LOOP_HARD_MAX_ITERATIONS,
      LOOP_HARD_MAX_ITERATIONS,
    );

    const rawState = input.variables[stateKey];
    let state: LoopState;

    if (rawState === undefined || rawState === null) {
      const payload = mergedPayload(input);
      const resolved = resolveDotPath(payload, config.itemsPath);

      if (!Array.isArray(resolved))
        return {
          kind: "failed",
          error:
            resolved === undefined
              ? `itemsPath "${config.itemsPath}" did not resolve to a value in the payload`
              : `itemsPath "${config.itemsPath}" resolved to ${typeof resolved}, not an array`,
        };

      if (resolved.length === 0)
        return {
          kind: "continue",
          branch: "done",
          output: { iterations: 0, stoppedEarly: false },
        };

      state = { items: resolved, index: 0 };
    } else {
      const stateParsed = loopStateSchema.safeParse(rawState);
      if (!stateParsed.success)
        return {
          kind: "failed",
          error: `Loop state is corrupted for node "${node.id}"`,
        };
      state = stateParsed.data;
    }

    if (state.index >= state.items.length) {
      delete input.variables[stateKey];
      return {
        kind: "continue",
        branch: "done",
        output: { iterations: state.index, stoppedEarly: false },
      };
    }

    if (state.index >= effectiveMax) {
      delete input.variables[stateKey];
      return {
        kind: "continue",
        branch: "done",
        output: { iterations: state.index, stoppedEarly: true },
      };
    }

    const currentItem = state.items[state.index];
    const currentIndex = state.index;

    state.index += 1;
    input.variables[stateKey] = state;
    input.variables[config.itemVariable] = currentItem;
    if (config.indexVariable !== undefined)
      input.variables[config.indexVariable] = currentIndex;

    return {
      kind: "continue",
      branch: "loop",
      output: {
        [config.itemVariable]: currentItem,
        ...(config.indexVariable !== undefined
          ? { [config.indexVariable]: currentIndex }
          : {}),
        iterationsRemaining: state.items.length - state.index,
      },
    };
  }
}
