jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import type { Request, Response } from "express";
import type { ServerResponse } from "http";
import { Test, type TestingModule } from "@nestjs/testing";
import { MeetingsPrepService } from "./meetings-prep.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { ComposioGateway } from "../../../integrations/core/composio.gateway";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { respondWithAiTextStream } from "../streaming";
import { agendaSources, agendaStreamPrompt, agendaStructuredPrompt } from "./meetings-prep-prompt";

const ORG_A = "org-A";
const USER_1 = "user-1";
const EVENT_ID = "101";
const SOURCES_HEADER = "x-ai-sources";

const EVENT_ROW = {
  id: 101,
  title: "Q3 Planning",
  startDate: new Date("2026-08-01T10:00:00Z"),
  endDate: new Date("2026-08-01T11:00:00Z"),
  description: "Quarterly planning session",
  location: "Conference Room A",
  meetingUrl: null,
  agenda: "Review Q3 goals",
  entityType: null,
  entityId: null,
  linkedLeadId: 77,
  linkedDealId: null,
  externalEventId: "gcal-evt-abc",
  integrationConnectionId: 1,
};

const ATTENDEES = [
  { userId: USER_1, name: "Alice Smith", status: "accepted" },
  { userId: "user-2", name: "Bob Jones", status: "tentative" },
];

const PROMPT_EVENT = { ...EVENT_ROW, attendees: ATTENDEES };

function mockThenable(resolveWith: unknown): jest.Mock {
  return jest.fn().mockResolvedValue(resolveWith);
}

function makeFluentChain(resolveWith: unknown) {
  const limit = mockThenable(resolveWith);
  const whereChain: Record<string, unknown> = {
    limit,
    innerJoin: jest.fn().mockReturnValue({ where: mockThenable(resolveWith) }),
  };
  whereChain.then = (res: (v: unknown) => unknown) => Promise.resolve(resolveWith).then(res);
  const where = jest.fn().mockReturnValue(whereChain);
  const joinChain: Record<string, unknown> = { where, limit };
  joinChain.innerJoin = jest.fn().mockReturnValue(joinChain);
  joinChain.leftJoin = jest.fn().mockReturnValue(joinChain);
  return { from: jest.fn().mockReturnValue(joinChain) };
}

function makeDb() {
  let call = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      call += 1;
      const mod = call % 3;
      if (mod === 1) return makeFluentChain([EVENT_ROW]);
      if (mod === 2) return makeFluentChain(ATTENDEES);
      return makeFluentChain([]);
    }),
  };
}

function makeGateway() {
  return {
    invokeStructured: jest.fn(),
    streamTextWithUsage: jest.fn().mockResolvedValue({
      stream: { pipeTextStreamToResponse: jest.fn().mockResolvedValue(undefined) },
      model: "gpt-4o-mini",
      correlationId: "corr-stream-1",
    }),
  } as unknown as jest.Mocked<AiGatewayService>;
}

async function buildService(gateway: jest.Mocked<AiGatewayService>) {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      MeetingsPrepService,
      { provide: AiGatewayService, useValue: gateway },
      { provide: AiConfirmationService, useValue: { propose: jest.fn(), confirm: jest.fn(), markExecuted: jest.fn() } },
      { provide: ComposioGateway, useValue: { isConfigured: () => false, executeTool: jest.fn() } },
      { provide: DRIZZLE, useValue: makeDb() },
    ],
  }).compile();
  return moduleRef.get(MeetingsPrepService);
}

describe("MeetingsPrepService.streamAgenda — the live calendar prep actually streams", () => {
  it("dispatches ONE paid streaming call with the caller's real actor", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);

    await service.streamAgenda(ORG_A, USER_1, EVENT_ID, {});

    expect(gateway.streamTextWithUsage).toHaveBeenCalledTimes(1);
    expect(gateway.streamTextWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        charge: true,
        feature: "meetings.prep",
        actor: { orgId: ORG_A, userId: USER_1 },
      }),
    );
    expect(gateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("hands the route's abort signal to the provider call, so a hang-up stops the spend", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);
    const controller = new AbortController();

    await service.streamAgenda(ORG_A, USER_1, EVENT_ID, {}, controller.signal);

    const opts = gateway.streamTextWithUsage.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(opts.signal).toBe(controller.signal);
  });

  it("returns sources built from the loaded context, not asked of the model", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);

    const result = await service.streamAgenda(ORG_A, USER_1, EVENT_ID, { includeCrmContext: true });

    expect(result.sources).toEqual([
      { id: "event-101", title: "Q3 Planning", snippet: "Calendar event details" },
      { id: "attendees-101", title: "2 attendees", snippet: "Alice Smith, Bob Jones" },
      { id: "crm-101", title: "Lead #77", snippet: "Linked CRM record" },
    ]);

    const opts = gateway.streamTextWithUsage.mock.calls[0]?.[0] as { prompt: { user: string } };
    expect(opts.prompt.user).not.toContain("Citations");
  });

  it("omits the CRM source when the caller did not ask for CRM context", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);

    const result = await service.streamAgenda(ORG_A, USER_1, EVENT_ID, {});

    expect(result.sources.map((s) => s.id)).toEqual(["event-101", "attendees-101"]);
  });
});

describe("meetings-prep-prompt — both representations brief the model on the same meeting", () => {
  it("the streamed prompt carries the same meeting details block as the structured one", () => {
    const structured = agendaStructuredPrompt(PROMPT_EVENT, { includeCrmContext: true });
    const streamed = agendaStreamPrompt(PROMPT_EVENT, { includeCrmContext: true });

    for (const fact of ["Q3 Planning", "Conference Room A", "Alice Smith", "CRM Link: Lead #77", "60 minutes"]) {
      expect(structured.user).toContain(fact);
      expect(streamed.user).toContain(fact);
    }
    expect(streamed.system).toBe(structured.system);
  });

  it("the streamed prompt asks for every section the structured schema held", () => {
    const streamed = agendaStreamPrompt(PROMPT_EVENT, {});

    for (const section of ["## Agenda", "## Key topics", "## Suggested duration", "## Preparation notes"]) {
      expect(streamed.user).toContain(section);
    }
  });

  it("never invents a source for a meeting with no attendees and no CRM link", () => {
    const bare = { ...PROMPT_EVENT, attendees: [], linkedLeadId: null, linkedDealId: null };

    expect(agendaSources(bare, { includeCrmContext: true })).toEqual([
      { id: "event-101", title: "Q3 Planning", snippet: "Calendar event details" },
    ]);
  });
});

function makeReq(): Request {
  return { on: jest.fn(), off: jest.fn(), complete: false, destroyed: false } as unknown as Request;
}

function makeRes(): Response & { writableEnded: boolean } {
  return {
    writableEnded: false,
    on: jest.fn(),
    off: jest.fn(),
    end: jest.fn(),
  } as unknown as Response & { writableEnded: boolean };
}

describe("respondWithAiTextStream — citations reach the client before the body", () => {
  it("publishes the producer's sources on the declared header", async () => {
    const pipe = jest.fn().mockResolvedValue(undefined);
    const res = makeRes();

    await respondWithAiTextStream(
      makeReq(),
      res,
      { feature: "meetings.prep", orgId: ORG_A, route: "POST /x", sourcesHeader: SOURCES_HEADER },
      async () => ({
        stream: { pipeTextStreamToResponse: pipe },
        sources: [{ id: "event-101", title: "Q3 Planning" }],
      }),
    );

    const init = pipe.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers[SOURCES_HEADER]).toBe(
      encodeURIComponent(JSON.stringify([{ id: "event-101", title: "Q3 Planning" }])),
    );
    expect(init.headers["access-control-expose-headers"]).toBe(SOURCES_HEADER);
  });

  it("sends no source header when the route declares none — the KB route keeps its own name", async () => {
    const pipe = jest.fn().mockResolvedValue(undefined);

    await respondWithAiTextStream(
      makeReq(),
      makeRes(),
      { feature: "f", orgId: ORG_A, route: "POST /x" },
      async () => ({
        stream: { pipeTextStreamToResponse: pipe as unknown as (r: ServerResponse) => Promise<void> },
        sources: [{ id: "1", title: "t" }],
      }),
    );

    expect(pipe.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("sends no source header when the producer found no sources", async () => {
    const pipe = jest.fn().mockResolvedValue(undefined);

    await respondWithAiTextStream(
      makeReq(),
      makeRes(),
      { feature: "f", orgId: ORG_A, route: "POST /x", sourcesHeader: SOURCES_HEADER },
      async () => ({ stream: { pipeTextStreamToResponse: pipe }, sources: [] }),
    );

    expect(pipe.mock.calls[0]?.[1]).toBeUndefined();
  });
});
