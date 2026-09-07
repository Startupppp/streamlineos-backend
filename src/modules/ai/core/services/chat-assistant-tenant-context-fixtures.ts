import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { getPostgresErrorDetails } from "../../../../common/db/postgres-error";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import type { AiCreditLedger } from "../gateway/credit-ledger.interface";
import type { AiUsageService } from "./ai-usage.service";
import { ChatAssistantService } from "./chat-assistant.service";
import { ChatHistoryService } from "./chat-history.service";

export function actorFor(orgId: string, userId: string, membershipId: number): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "ADMIN",
    isOrgOwner: false,
    sessionId: "sess_chat_guc",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

export function makeLedger(): jest.Mocked<AiCreditLedger> {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 4242 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function makeUsageSvc(): jest.Mocked<AiUsageService> {
  return { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
}

export async function sqlstateOfRejection(run: () => Promise<unknown>): Promise<string | undefined> {
  const error: unknown = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeDefined();
  return getPostgresErrorDetails(error).code;
}

export function buildService(db: Db, ledger: jest.Mocked<AiCreditLedger>): ChatAssistantService {
  const noop = { buildTools: jest.fn().mockReturnValue({}) };
  const toolAccess = { denyReason: jest.fn().mockResolvedValue(null) };
  const moduleRef = { get: jest.fn().mockReturnValue({ ask: jest.fn() }) };
  const limiter = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };

  return new ChatAssistantService(
    db,
    { ask: jest.fn(), summarize: jest.fn() } as unknown as never,
    new ChatHistoryService(db),
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    noop as unknown as never,
    toolAccess as unknown as never,
    moduleRef as unknown as never,
    makeUsageSvc(),
    ledger,
    null,
    limiter as unknown as never,
  );
}
