import { BadRequestException, Injectable } from "@nestjs/common";
import { AiGatewayService } from "../../ai/gateway/ai-gateway.service";
import { throwOnAiFailure } from "../../ai/services/gateway-result.util";
import { AiConfirmationService } from "../../ai-confirmation/ai-confirmation.service";
import { AuditService } from "../../../common/audit/audit.service";
import {
  classifyNodeConfigSchema,
  classifyNodeOutputSchema,
  extractNodeConfigSchema,
  extractNodeOutputSchema,
  routingSuggestionNodeConfigSchema,
  routingSuggestionNodeOutputSchema,
  summarizeNodeConfigSchema,
  type AiNodeType,
} from "./ai-node-types";


export interface AiNodeResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  proposalToken?: string;
}

@Injectable()
export class AiNodeExecutorService {
  constructor(
    private readonly gateway: AiGatewayService,
    private readonly confirmation: AiConfirmationService,
    private readonly audit: AuditService,
  ) {}

  async executeNode(
    orgId: string,
    userId: string,
    nodeType: AiNodeType,
    nodeConfig: unknown,
    payload: Record<string, unknown>,
  ): Promise<AiNodeResult> {
    const actor = { orgId, userId };

    if (nodeType === "classify") {
      const parsed = classifyNodeConfigSchema.safeParse(nodeConfig);
      if (!parsed.success) {
        throw new BadRequestException(`Invalid classify node config: ${parsed.error.message}`);
      }
      const config = parsed.data;
      const fieldValue = payload[config.field];
      const fieldText = fieldValue !== undefined ? String(fieldValue) : "(empty)";

      const result = await this.gateway.invokeStructured({
        actor,
        feature,
        prompt: {
          system: `You are a classification engine. Classify the given text into exactly one of the provided labels.`,
          user: `Text to classify: "${fieldText}"\n\nLabels: ${config.labels.join(", ")}\n\nRespond with the matching label and a confidence score between 0 and 1.`,
        },
        schema: classifyNodeOutputSchema,
        charge: true,
        tier: "fast",
      });

      this.audit.log({
        action: "automation.ai_node.executed",
        userId,
        orgId,
        metadata: { nodeType, feature, ok: result.ok },
      });

      if (!result.ok) throwOnAiFailure(result);
      return { ok: true, output: result.data };
    }

    if (nodeType === "summarize") {
      const parsed = summarizeNodeConfigSchema.safeParse(nodeConfig);
      if (!parsed.success) {
        throw new BadRequestException(`Invalid summarize node config: ${parsed.error.message}`);
      }
      const config = parsed.data;
      const fieldTexts = config.fields
        .map((f) => `${f}: ${payload[f] !== undefined ? String(payload[f]) : "(empty)"}`)
        .join("\n");

      const result = await this.gateway.invokeText({
        actor,
        feature,
        prompt: {
          system: `You are a summarization engine. Summarize the provided fields into a single concise paragraph.`,
          user: `Fields to summarize:\n${fieldTexts}`,
        },
        charge: true,
        tier: "fast",
      });

      this.audit.log({
        action: "automation.ai_node.executed",
        userId,
        orgId,
        metadata: { nodeType, feature, ok: result.ok },
      });

      if (!result.ok) throwOnAiFailure(result);
      return { ok: true, output: { summary: result.data } };
    }

    if (nodeType === "extract") {
      const parsed = extractNodeConfigSchema.safeParse(nodeConfig);
      if (!parsed.success) {
        throw new BadRequestException(`Invalid extract node config: ${parsed.error.message}`);
      }
      const config = parsed.data;
      const fieldDescriptions = config.fields
        .map((f) => `- ${f.name} (${f.type}): ${f.description}`)
        .join("\n");
      const payloadText = JSON.stringify(payload, null, 2);

      const result = await this.gateway.invokeStructured({
        actor,
        feature,
        prompt: {
          system: `You are a structured data extraction engine. Extract the requested fields from the provided payload.`,
          user: `Extract the following fields:\n${fieldDescriptions}\n\nFrom this payload:\n${payloadText}`,
        },
        schema: extractNodeOutputSchema,
        charge: true,
        tier: "fast",
      });

      this.audit.log({
        action: "automation.ai_node.executed",
        userId,
        orgId,
        metadata: { nodeType, feature, ok: result.ok },
      });

      if (!result.ok) throwOnAiFailure(result);
      return { ok: true, output: result.data };
    }

    const parsed = routingSuggestionNodeConfigSchema.safeParse(nodeConfig);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid routing_suggestion node config: ${parsed.error.message}`);
    }
    const config = parsed.data;
    const fieldValue = payload[config.field];
    const fieldText = fieldValue !== undefined ? String(fieldValue) : "(empty)";

    const llmSchema = routingSuggestionNodeOutputSchema.omit({ proposalToken: true });
    const result = await this.gateway.invokeStructured({
      actor,
      feature,
      prompt: {
        system: `You are a routing decision engine. Suggest the best routing option for the given input and explain your reasoning.`,
        user: `Field value: "${fieldText}"\n\nRouting options: ${config.options.join(", ")}\n\nSelect the best option and provide your reasoning.`,
      },
      schema: llmSchema,
      charge: true,
      tier: "standard",
    });

    this.audit.log({
      action: "automation.ai_node.executed",
      userId,
      orgId,
      metadata: { nodeType, feature, ok: result.ok },
    });

    if (!result.ok) throwOnAiFailure(result);

    const { token } = await this.confirmation.propose({
      orgId,
      userId,
      action: "route",
      payload: { suggestion: result.data.suggestion, options: config.options },
      ttlSeconds: 3600,
    });

    return {
      ok: true,
      output: { ...result.data, proposalToken: token },
      proposalToken: token,
    };
  }
}
