import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type {
  AiInvokeBaseOpts,
  AiInvokeFailure,
  AiInvokeWithUsageResult,
} from "../../../ai/core/gateway/ai-gateway.types";
import {
  mergedPayload,
  type NodeExecutionContext,
  type NodeExecutionInput,
  type NodeOutcome,
  type WorkflowNodeExecutor,
} from "../node-outcome";
import type { WorkflowGraphNode } from "../workflow-graph";

export const AI_TEXT_GATEWAY = Symbol("AI_TEXT_GATEWAY");

export interface AiTextGateway {
  invokeTextWithUsage(
    opts: AiInvokeBaseOpts,
  ): Promise<AiInvokeWithUsageResult<string>>;
}

const MAX_PROMPT_CHARS = 4_000;
const MAX_OUTPUT_TOKENS = 2_000;
const INTERPOLATION_RE = /\{\{(\w+)\}\}/g;

const aiActionConfigSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  model: z.enum(["fast", "standard"]).optional(),
  maxOutputTokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS).optional(),
  outputVariable: z.string().min(1).optional(),
});

type AiActionConfig = z.infer<typeof aiActionConfigSchema>;

function interpolateVars(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(INTERPOLATION_RE, (_, key: string) => {
    const val = vars[key];
    return val !== null && val !== undefined ? String(val) : `{{${key}}}`;
  });
}

function failureToMessage(
  kind: AiInvokeFailure["kind"],
  providerMessage: string,
): string {
  switch (kind) {
    case "quota_exceeded":
      return "AI credit quota exhausted — top up your AI credit balance to continue";
    case "not_configured":
      return "AI provider is not configured for this organisation";
    case "provider_unavailable":
      return `AI provider temporarily unavailable: ${providerMessage}`;
    case "invalid_output":
      return "AI returned an unexpected or malformed response";
    case "context_too_large":
      return "The workflow context is too large for the AI provider — reduce prompt size or variable payload";
  }
}

@Injectable()
export class WorkflowAiActionExecutor implements WorkflowNodeExecutor {
  constructor(
    @Inject(AI_TEXT_GATEWAY) private readonly gateway: AiTextGateway,
  ) {}

  async execute(
    node: WorkflowGraphNode,
    input: NodeExecutionInput,
    _now: Date,
    context: NodeExecutionContext,
  ): Promise<NodeOutcome> {
    const parsed = aiActionConfigSchema.safeParse(
      node.data.configuration ?? {},
    );
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return {
        kind: "failed",
        error: `ai_action node misconfigured: ${firstIssue?.message ?? "validation failed"}`,
      };
    }

    const config: AiActionConfig = parsed.data;
    const vars = mergedPayload(input);
    const resolvedPrompt = interpolateVars(config.prompt, vars);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: context.orgId, userId: context.userId },
      feature: "workflows:ai_action",
      prompt: {
        system:
          "You are a helpful workflow automation assistant. Be concise.",
        user: resolvedPrompt,
      },
      tier: config.model ?? "fast",
      charge: true,
      ...(config.maxOutputTokens !== undefined
        ? { maxTokens: config.maxOutputTokens }
        : {}),
    });

    if (!result.ok)
      return {
        kind: "failed",
        error: failureToMessage(result.kind, result.message),
      };

    const output: Record<string, unknown> = {
      text: result.data,
      aiUsage: result.aiUsage,
    };

    if (config.outputVariable !== undefined)
      output[config.outputVariable] = result.data;

    return { kind: "continue", output };
  }
}
