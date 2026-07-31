import { Injectable, OnModuleInit } from "@nestjs/common";
import { AiJobHandlerRegistry, type AiJobContext, type AiJobHandler } from "../../ai/jobs/ai-job-handler";
import { SupportKbGapService } from "./support-kb-gap.service";

@Injectable()
export class SupportKbGapJobHandler implements AiJobHandler, OnModuleInit {
  readonly type = "support.kb-gap-detect";

  constructor(
    private readonly supportKbGap: SupportKbGapService,
    private readonly registry: AiJobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(job: AiJobContext): Promise<Record<string, unknown>> {
    const orgId = String(job.payload["orgId"] ?? job.orgId);
    return await this.supportKbGap.detectGaps(orgId);
  }
}
