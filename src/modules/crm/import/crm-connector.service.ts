import { Injectable } from "@nestjs/common";
import { CrmConnectorWalkService } from "./crm-connector-walk.service";
import { CrmConnectorLifecycleService } from "./crm-connector-lifecycle.service";
import type { WalkExtent, PageOutcome, WalkResult } from "./crm-connector-internals";
import type { ConnectorProvider, ConnectorStream, ConnectorRequest } from "./connectors/connector-source";

export { type WalkExtent, type PageOutcome, type WalkResult, MAX_PAGES_PER_WALK, FAILURE_LIMIT } from "./crm-connector-internals";

@Injectable()
export class CrmConnectorService {
  constructor(
    private readonly walkSvc: CrmConnectorWalkService,
    private readonly lifecycleSvc: CrmConnectorLifecycleService,
  ) {}

  async startSync(input: {
    organizationId: string;
    userId: string;
    connectionId: number;
    provider: ConnectorProvider;
    stream: ConnectorStream;
  }): Promise<{ crmConnectorSyncId: string; workflowRunId: string }> {
    return this.lifecycleSvc.startSync(input);
  }

  async beginWalk(organizationId: string, crmConnectorSyncId: string): Promise<WalkExtent> {
    return this.walkSvc.beginWalk(organizationId, crmConnectorSyncId);
  }

  async fetchPage(
    organizationId: string,
    crmConnectorSyncId: string,
    request: ConnectorRequest,
  ): Promise<PageOutcome> {
    return this.walkSvc.fetchPage(organizationId, crmConnectorSyncId, request);
  }

  isFull(total: number): boolean {
    return this.walkSvc.isFull(total);
  }

  async finishWalk(
    organizationId: string,
    crmConnectorSyncId: string,
    drained: boolean,
  ): Promise<WalkResult> {
    return this.walkSvc.finishWalk(organizationId, crmConnectorSyncId, drained);
  }

  async recordFailure(
    organizationId: string,
    crmConnectorSyncId: string,
    message: string,
  ): Promise<void> {
    return this.lifecycleSvc.recordFailure(organizationId, crmConnectorSyncId, message);
  }

  async progress(organizationId: string, crmConnectorSyncId: string) {
    return this.lifecycleSvc.progress(organizationId, crmConnectorSyncId);
  }
}
