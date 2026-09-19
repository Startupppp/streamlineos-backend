import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { getPostgresErrorDetails } from "../../../../common/db/postgres-error";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { AiCreditLedger } from "../gateway/credit-ledger.interface";
import { AiUsageService } from "./ai-usage.service";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";
import { AccessService } from "../../../access/access.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import {
  AiGatewayStreamHelper,
  type AiStreamTextOpts,
} from "../gateway/ai-gateway-stream.helper";
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
  const limiter: AiConcurrencyLimiter = Object.assign(Object.create(AiConcurrencyLimiter.prototype), {
    acquire: jest.fn().mockResolvedValue(true),
    release: jest.fn(),
  });

  const streamHelper = new AiGatewayStreamHelper(ledger, makeUsageSvc(), limiter, null);
  const gateway: AiGatewayService = Object.assign(Object.create(AiGatewayService.prototype), {
    streamAgenticTurn: (opts: AiStreamTextOpts) => streamHelper.run(opts),
    streamTextWithUsage: (opts: AiStreamTextOpts) => streamHelper.run(opts),
  });

  const access = {
    getAccessSnapshot: jest.fn().mockResolvedValue({
      membershipId: 1,
      scopes: {},
      modules: {},
      isOrgOwner: false,
      canManageOrganizationMembership: false,
      mfa: { enforced: false, satisfied: true },
      version: 0,
    }),
  };

  return new ChatAssistantService(
    db,
    gateway,
    new ChatHistoryService(db),
    access as unknown as AccessService,
    [],
  );
}
