import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";
import { ProjectsTicketsService } from "./projects-tickets.service";

// The guard half of the matrix, which needs no database — `projects-tickets-key.e2e-spec.ts` skips without `RBAC_E2E_DATABASE_URL` and keeps the not-found cases.

const TICKET = { id: 91, ticketNumber: 101, title: "Deep-linked ticket" };

const byId = "/build/1/tickets/91";
const byKey = "/build/1/tickets/key/101";

describe("ticket by key — allows and denies exactly as ticket by id (e2e)", () => {
  let app: INestApplication;
  const ticketsStub = {
    getTicket: jest.fn(() => Promise.resolve(TICKET)),
    getTicketByKey: jest.fn(() => Promise.resolve(TICKET)),
  };

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: ProjectsTicketsService, useValue: ticketsStub }],
    });
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    ticketsStub.getTicket.mockClear();
    ticketsStub.getTicketByKey.mockClear();
  });

  function get(path: string, token?: string): request.Test {
    const call = request(app.getHttpServer()).get(path);
    return token ? call.set("Authorization", `Bearer ${token}`) : call;
  }

  const actors: ReadonlyArray<{
    name: string;
    status: number;
    reachesHandler: boolean;
    token?: () => Promise<string>;
  }> = [
    { name: "no token at all", status: 401, reachesHandler: false },
    {
      name: "a member with no permissions",
      status: 403,
      reachesHandler: false,
      token: () => signToken({ permissions: [], enabledModules: ALL_MODULES }),
    },
    {
      name: "a member holding a neighbouring key but not the read key",
      status: 403,
      reachesHandler: false,
      token: () => signToken({ permissions: ["build:tickets:create"], enabledModules: ALL_MODULES }),
    },
    {
      name: "a member whose organisation does not have Build enabled",
      status: 403,
      reachesHandler: false,
      token: () => signToken({ permissions: ["build:tickets:view"], enabledModules: [] }),
    },
    {
      name: "a member holding build:tickets:view",
      status: 200,
      reachesHandler: true,
      token: () => signToken({ permissions: ["build:tickets:view"], enabledModules: ALL_MODULES }),
    },
  ];

  for (const actor of actors) {
    it(`answers ${actor.status} on both routes for ${actor.name}`, async () => {
      const token = actor.token ? await actor.token() : undefined;

      const idResponse = await get(byId, token);
      const keyResponse = await get(byKey, token);

      expect(keyResponse.status).toBe(actor.status);
      expect(keyResponse.status).toBe(idResponse.status);
    });

    it(`${actor.reachesHandler ? "reaches" : "stops before"} the read for ${actor.name}`, async () => {
      const token = actor.token ? await actor.token() : undefined;

      await get(byKey, token);

      expect(ticketsStub.getTicketByKey).toHaveBeenCalledTimes(actor.reachesHandler ? 1 : 0);
    });
  }

  it("resolves the key server-side rather than by position, so any ticket number is asked for directly", async () => {
    const token = await signToken({ permissions: ["build:tickets:view"], enabledModules: ALL_MODULES });

    const response = await get("/build/1/tickets/key/24601", token);

    expect(response.status).toBe(200);
    expect(ticketsStub.getTicketByKey).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: expect.any(String) }),
      1,
      24601,
    );
  });

  it("does not shadow the by-id route, which still receives its own id", async () => {
    const token = await signToken({ permissions: ["build:tickets:view"], enabledModules: ALL_MODULES });

    await get(byId, token);

    expect(ticketsStub.getTicket).toHaveBeenCalledWith(expect.anything(), 91);
    expect(ticketsStub.getTicketByKey).not.toHaveBeenCalled();
  });
});
