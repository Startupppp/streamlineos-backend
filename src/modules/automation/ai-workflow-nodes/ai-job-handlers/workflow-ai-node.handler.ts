import { Injectable, type OnModuleInit } from "@nestjs/common";
import { AiJobHandlerRegistry, type AiJobContext, type AiJobHandler } from "../../../ai/jobs/ai-job-handler";
import { AiJobsService } from "../../../ai/jobs/ai-jobs.service";
import { AiNodeExecutorService } from "../ai-node-executor.service";
import type { AiNodeType } from "../ai-node-types";

const VALID_NODE_TYPES = new Set<string>(["classify", "summarize", "extract", "routing_suggestion"]);

function isAiNodeType(value: unknown): value is AiNodeType {
  return typeof value === "string" && VALID_NODE_TYPES.has(value);
}

@Injectable()
export class WorkflowAiNodeHandler implements AiJobHandler, OnModuleInit {
  readonly type = "workflow.ai_node";

  constructor(
    private readonly executor: AiNodeExecutorService,
    private readonly aiJobs: AiJobsService,
    private readonly registry: AiJobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(job: AiJobContext): Promise<Record<string, unknown>> {
    const { orgId, userId, payload } = job;

    const nodeType = payload["nodeType"];
    if (!isAiNodeType(nodeType)) {
      const err = `Invalid or missing nodeType: ${String(nodeType)}`;
      await this.aiJobs.fail(job.id, err);
      return { ok: false, error: err };
    }

    const nodeConfig = payload["nodeConfig"] ?? {};
    const automationPayload = (payload["automationPayload"] ?? {}) as Record<string, unknown>;

    try {
      const result = await this.executor.executeNode(
        orgId,
        userId ?? "system",
        nodeType,
        nodeConfig,
        automationPayload,
      );
      const output: Record<string, unknown> = { ...result };
      await this.aiJobs.complete(job.id, output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workflow AI node execution failed";
      await this.aiJobs.fail(job.id, message);
      return { ok: false, error: message };
    }
  }
}
