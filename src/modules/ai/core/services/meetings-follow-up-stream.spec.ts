jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { MeetingsPrepService } from "./meetings-prep.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { ComposioGateway } from "../../../integrations/core/composio.gateway";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { followUpPrompt, followUpSources, followUpStreamPrompt } from "./meetings-prep-prompt";

const ORG_A = "org-A";
const USER_1 = "user-1";
const EVENT_ID = "101";
const NOTES = "Agreed to ship the pilot in October. Priya raised the migration risk.";
const ITEMS = ["Draft the migration plan", "Book the follow-up review"];

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
  { userId: "user-2", name: "Priya Rao", status: "tentative" },
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

function makeDb(eventRows: unknown[] = [EVENT_ROW]) {
  let call = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return makeFluentChain(eventRows);
      return makeFluentChain(ATTENDEES);
    }),
  };
}

function makeGateway() {
  return {
    invokeStructured: jest.fn(),
    streamTextWithUsage: jest.fn().mockResolvedValue({
      stream: { pipeTextStreamToResponse: jest.fn().mockResolvedValue(undefined) },
      model: "gpt-4o-mini",
      correlationId: "corr-follow-up-1",
    }),
  } as unknown as jest.Mocked<AiGatewayService>;
}

async function buildService(gateway: jest.Mocked<AiGatewayService>, db: unknown = makeDb()) {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      MeetingsPrepService,
      { provide: AiGatewayService, useValue: gateway },
      { provide: AiConfirmationService, useValue: { propose: jest.fn(), confirm: jest.fn(), markExecuted: jest.fn() } },
      { provide: ComposioGateway, useValue: { isConfigured: () => false, executeTool: jest.fn() } },
      { provide: DRIZZLE, useValue: db },
    ],
  }).compile();
  return moduleRef.get(MeetingsPrepService);
}

describe("MeetingsPrepService.streamFollowUp — the live calendar follow-up actually streams", () => {
  it("dispatches ONE paid streaming call with the caller's real actor and the metered feature key", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);

    await service.streamFollowUp(ORG_A, USER_1, EVENT_ID, NOTES, ITEMS);

    expect(gateway.streamTextWithUsage).toHaveBeenCalledTimes(1);
    expect(gateway.streamTextWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        charge: true,
        feature: "meetings.follow-up",
        actor: { orgId: ORG_A, userId: USER_1 },
      }),
    );
    expect(gateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("bills the same feature key as the buffered sibling, so the two cannot meter differently", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);
    const buffered = makeGateway();
    (buffered.invokeStructured as jest.Mock).mockResolvedValue({
      ok: true,
      data: { subject: "s", body: "b", actionItems: [] },
    });
    const bufferedService = await buildService(buffered);

    await service.streamFollowUp(ORG_A, USER_1, EVENT_ID, NOTES, ITEMS);
    await bufferedService.draftFollowUp(ORG_A, USER_1, EVENT_ID, NOTES, ITEMS);

    const streamed = gateway.streamTextWithUsage.mock.calls[0]?.[0] as { feature: string; charge: boolean };
    const structured = (buffered.invokeStructured as jest.Mock).mock.calls[0]?.[0] as {
      feature: string;
      charge: boolean;
    };
    expect(streamed.feature).toBe(structured.feature);
    expect(streamed.charge).toBe(structured.charge);
  });

  it("hands the route's abort signal to the provider call, so a hang-up stops the spend", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);
    const controller = new AbortController();

    await service.streamFollowUp(ORG_A, USER_1, EVENT_ID, NOTES, ITEMS, controller.signal);

    const opts = gateway.streamTextWithUsage.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(opts.signal).toBe(controller.signal);
  });

  it("returns sources built from the loaded context and the organizer's own input", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);

    const result = await service.streamFollowUp(ORG_A, USER_1, EVENT_ID, NOTES, ITEMS);

    expect(result.sources.map((s) => s.id)).toEqual([
      "event-101",
      "attendees-101",
      "notes-101",
      "action-items-101",
    ]);
  });

  it("cites nothing the organizer did not supply", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway);

    const result = await service.streamFollowUp(ORG_A, USER_1, EVENT_ID, undefined, []);

    expect(result.sources.map((s) => s.id)).toEqual(["event-101", "attendees-101"]);
  });

  it("a cross-tenant event id is a 404, never a 403 — a miss must not confirm the row exists", async () => {
    const gateway = makeGateway();
    const service = await buildService(gateway, makeDb([]));

    await expect(service.streamFollowUp("org-B", USER_1, EVENT_ID, NOTES, ITEMS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.streamFollowUp("org-B", USER_1, EVENT_ID, NOTES, ITEMS)).rejects.not.toBeInstanceOf(
      ForbiddenException,
    );
    expect(gateway.streamTextWithUsage).not.toHaveBeenCalled();
  });
});

describe("meetings-prep-prompt — both follow-up representations brief the model on the same meeting", () => {
  it("the streamed prompt carries the same facts as the buffered one", () => {
    const structured = followUpPrompt(PROMPT_EVENT, NOTES, ITEMS);
    const streamed = followUpStreamPrompt(PROMPT_EVENT, NOTES, ITEMS);

    for (const fact of ["Q3 Planning", "Alice Smith", "Priya Rao", "Draft the migration plan", NOTES]) {
      expect(structured.user).toContain(fact);
      expect(streamed.user).toContain(fact);
    }
    expect(streamed.system).toBe(structured.system);
  });

  it("asks for every section the structured schema holds, in a shape a partial line still parses", () => {
    const streamed = followUpStreamPrompt(PROMPT_EVENT, undefined, undefined);

    for (const section of ["## Subject", "## Email", "## Action items", "## Next meeting"]) {
      expect(streamed.user).toContain(section);
    }
    expect(streamed.user).toContain("| owner: <name or unassigned> | due: <date or none>");
  });

  it("caps a long note snippet so the citation header cannot swallow the whole transcript", () => {
    const long = "x".repeat(1000);
    const sources = followUpSources(PROMPT_EVENT, long, undefined);
    const notes = sources.find((s) => s.id === "notes-101");

    expect(notes?.snippet?.length).toBeLessThanOrEqual(161);
  });
});
