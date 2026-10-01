import { getTenantContext } from "../../../common/tenant/tenant-context";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import type { Db } from "../../../db/drizzle.module";
import { withDelegatingTransaction } from "../../../test/delegating-transaction";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { CommentDraftGeneratorService } from "./comment-draft-generator.service";
import { CommentDraftsController } from "./comment-drafts.controller";
import type { CommentDraftsService } from "./comment-drafts.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG_ID = "org-comment-draft";
const USER_ID = "user-comment-draft";
const MEMBERSHIP_ID = 42;
const TICKET_ID = 99;
const ACTOR: CurrentUserContext = {
  userId: USER_ID,
  orgId: ORG_ID,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
};

interface Trace {
  transactionDepth: number;
  transactions: number;
  dbDepths: number[];
  providerDepth: number | undefined;
  writeDepth: number | undefined;
}

const ticketRow = {
  id: TICKET_ID,
  title: "Fix login timeout",
  description: "Users are getting logged out",
  status: "IN_PROGRESS",
  priority: "HIGH",
  type: "BUG",
};

const aiOutput = {
  body: "Extend the session timeout to 30 minutes.",
  evidence: "Users report repeated timeouts.",
  proposedChange: "Increase the session TTL.",
  impact: "Authenticated users.",
  confidence: 80,
  affectedRecordIds: [TICKET_ID],
};

const aiUsage = {
  model: "gpt-4o-mini",
  promptTokens: 120,
  completionTokens: 60,
  totalTokens: 180,
  credits: 1,
  costUsd: 0.0002,
};

function record<T>(trace: Trace, value: T): Promise<T> {
  trace.dbDepths.push(trace.transactionDepth);
  return Promise.resolve(value);
}

function tracingDb(trace: Trace): Db {
  let selectIndex = 0;
  const double = withDelegatingTransaction({
    execute: () => record(trace, []),
    select: () => {
      const result = selectIndex++ === 0 ? [ticketRow] : [{ content: "Reproduced on staging." }];
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "orderBy"])
        chain[method] = () => chain;
      chain.limit = () => record(trace, result);
      return chain;
    },
  });

  Object.assign(double, {
    transaction: async <T>(run: (tx: Db) => Promise<T>): Promise<T> => {
      trace.transactions += 1;
      trace.transactionDepth += 1;
      try {
        return await run(double as unknown as Db);
      } finally {
        trace.transactionDepth -= 1;
      }
    },
  });

  return double as unknown as Db;
}

function makeService(
  trace: Trace,
  providerResult:
    | { ok: true; data: typeof aiOutput; aiUsage: typeof aiUsage; correlationId: string }
    | { ok: false; kind: "provider_unavailable"; message: string; correlationId: string },
): { service: CommentDraftGeneratorService; drafts: jest.Mocked<Pick<CommentDraftsService, "assertTicketReadable" | "upsertGenerated">> } {
  const gateway = {
    invokeStructuredWithUsage: jest.fn().mockImplementation(async () => {
      trace.providerDepth = getTenantContext() ? trace.transactionDepth : 0;
      return providerResult;
    }),
  } as unknown as AiGatewayService;
  const drafts = {
    assertTicketReadable: jest.fn().mockResolvedValue(undefined),
    upsertGenerated: jest.fn().mockImplementation(async () => {
      trace.writeDepth = getTenantContext() ? trace.transactionDepth : 0;
      return { id: 1, ...aiOutput };
    }),
  };

  return {
    service: new CommentDraftGeneratorService(
      tracingDb(trace),
      gateway,
      drafts as unknown as CommentDraftsService,
    ),
    drafts,
  };
}

function newTrace(): Trace {
  return {
    transactionDepth: 0,
    transactions: 0,
    dbDepths: [],
    providerDepth: undefined,
    writeDepth: undefined,
  };
}

describe("comment draft generation connection hold", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("opts the generate handler out of the request-wide tenant transaction", () => {
    expect(
      Reflect.getMetadata(
        NO_TENANT_TRANSACTION,
        CommentDraftsController.prototype.generateDraft,
      ),
    ).toBe(true);
  });

  it("ANTI-VACUITY: leaves ordinary comment-draft reads inside the request transaction", () => {
    expect(
      Reflect.getMetadata(
        NO_TENANT_TRANSACTION,
        CommentDraftsController.prototype.listMine,
      ),
    ).toBeUndefined();
  });

  it("releases the read transaction before a provider failure and opens no write transaction", async () => {
    const trace = newTrace();
    const { service, drafts } = makeService(trace, {
      ok: false,
      kind: "provider_unavailable",
      message: "provider unavailable",
      correlationId: "corr-fail",
    });

    await expect(
      service.generate(ACTOR, TICKET_ID),
    ).rejects.toThrow("AI draft generation failed");

    expect(trace.providerDepth).toBe(0);
    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
    expect(drafts.upsertGenerated).not.toHaveBeenCalled();
  });

  it("keeps DB work in two short transactions and invokes the provider at depth zero", async () => {
    const trace = newTrace();
    const { service } = makeService(trace, {
      ok: true,
      data: aiOutput,
      aiUsage,
      correlationId: "corr-ok",
    });

    await service.generate(ACTOR, TICKET_ID);

    expect(trace.dbDepths.length).toBeGreaterThan(0);
    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
    expect(trace.providerDepth).toBe(0);
    expect(trace.writeDepth).toBe(1);
    expect(trace.transactions).toBe(2);
    expect(trace.transactionDepth).toBe(0);
  });
});
