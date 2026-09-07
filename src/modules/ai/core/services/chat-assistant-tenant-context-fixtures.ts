import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { getPostgresErrorDetails } from "../../../../common/db/postgres-error";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { AiCreditLedger } from "../gateway/credit-ledger.interface";
import { AiUsageService } from "./ai-usage.service";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";
import { ToolAccessService } from "../tool-access.service";
import { ProjectsAiService } from "./projects-ai.service";
import { HrCopilotTools } from "../hr-copilot-tools";
import { WorkspaceCopilotTools } from "../workspace-copilot-tools";
import { OpsCopilotTools } from "../ops-copilot-tools";
import { CrmCopilotTools } from "../crm-copilot-tools";
import { CommsCopilotTools } from "../comms-copilot-tools";
import { ProjectsCopilotTools } from "../projects-copilot-tools";
import { CommsActionsTools } from "../comms-actions-tools";
import { MailCopilotTools } from "../mail-copilot-tools";
import { ModuleRef } from "@nestjs/core";
import { ChatAssistantService } from "./chat-assistant.service";
import { ChatHistoryService } from "./chat-history.service";

export function actorFor(orgId: string, userId: string, membershipId: number): CurrentUserContext {
  return { userId, orgId, role: "ADMIN", isOrgOwner: false, sessionId: "sess_chat_guc",
    tokenScopes: null, principal: humanSessionPrincipal(membershipId, false) };
}

export function makeLedger(): jest.Mocked<AiCreditLedger> {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 4242 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

function makeUsageSvc(): AiUsageService {
  return Object.assign(Object.create(AiUsageService.prototype), {
    track: jest.fn().mockResolvedValue(undefined),
  });
}

export async function sqlstateOfRejection(run: () => Promise<unknown>): Promise<string | undefined> {
  const error: unknown = await run().then(() => undefined, (e: unknown) => e);
  expect(error).toBeDefined();
  return getPostgresErrorDetails(error).code;
}

export function buildService(db: Db, ledger: jest.Mocked<AiCreditLedger>): ChatAssistantService {
  const projectsAi: ProjectsAiService = Object.assign(Object.create(ProjectsAiService.prototype), {
    ask: jest.fn(),
    summarize: jest.fn(),
  });
  const hrCopilot: HrCopilotTools = Object.assign(Object.create(HrCopilotTools.prototype), {
    buildTools: jest.fn().mockReturnValue({}),
  });
  const workspaceCopilot: WorkspaceCopilotTools = Object.assign(Object.create(WorkspaceCopilotTools.prototype), {
    buildTools: jest.fn().mockReturnValue({}),
  });
  const opsCopilot: OpsCopilotTools = Object.assign(Object.create(OpsCopilotTools.prototype), {
    buildTools: jest.fn().mockReturnValue({}),
  });
  const crmCopilot: CrmCopilotTools = Object.assign(Object.create(CrmCopilotTools.prototype), {
    buildTools: jest.fn().mockReturnValue({}),
  });
  const commsCopilot: CommsCopilotTools = Object.assign(Object.create(CommsCopilotTools.prototype), {
    buildTools: jest.fn().mockReturnValue({}),
  });
  const projectsCopilot: ProjectsCopilotTools = Object.assign(Object.create(ProjectsCopilotTools.prototype), {
    buildTools: jest.fn().mockReturnValue({}),
  });
  const commsActions: CommsActionsTools = Object.assign(Object.create(CommsActionsTools.prototype), {
    buildTools: jest.fn().mockReturnValue({}),
  });
  const mailCopilot: MailCopilotTools = Object.assign(Object.create(MailCopilotTools.prototype), {
    buildTools: jest.fn().mockReturnValue({}),
  });
  const toolAccess: ToolAccessService = Object.assign(Object.create(ToolAccessService.prototype), {
    denyReason: jest.fn().mockResolvedValue(null),
  });
  const moduleRef: ModuleRef = Object.assign(Object.create(ModuleRef.prototype), {
    get: jest.fn().mockReturnValue({ ask: jest.fn() }),
  });
  const limiter: AiConcurrencyLimiter = Object.assign(Object.create(AiConcurrencyLimiter.prototype), {
    acquire: jest.fn().mockResolvedValue(true),
    release: jest.fn(),
  });

  return new ChatAssistantService(
    db,
    projectsAi,
    new ChatHistoryService(db),
    hrCopilot,
    workspaceCopilot,
    opsCopilot,
    crmCopilot,
    commsCopilot,
    projectsCopilot,
    commsActions,
    mailCopilot,
    toolAccess,
    moduleRef,
    makeUsageSvc(),
    ledger,
    null,
    limiter,
  );
}
