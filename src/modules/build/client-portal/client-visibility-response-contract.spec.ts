import "reflect-metadata";
import openapi from "../../../../openapi.json";
import { RESPONSE_SCHEMA } from "../../../common/openapi/zod-operation-contracts";
import { ClientVisibilityController } from "./client-visibility.controller";
import { ClientVisibilityService } from "./client-visibility.service";
import { visibilitySummarySchema } from "./dto/client-portal-response.schemas";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { principalAccess, projectAccessRow } from "../core/project-crud/__tests__/project-access-doubles";

type OpenApiObject = Record<string, unknown>;

const visibilitySummary = {
  tickets: {
    data: [{ id: 11, ticketNumber: 42, title: "Fix login", type: "BUG", clientVisible: true, version: 7 }],
    pagination: { limit: 50, hasMore: false, nextCursor: null },
  },
  milestones: {
    data: [{ id: 3, name: "Beta", clientVisible: true }],
    pagination: { limit: 50, hasMore: false, nextCursor: null },
  },
};

describe("client visibility response contract", () => {
  it("keeps the ticket version in the source response shape for optimistic concurrency", () => {
    expect(visibilitySummarySchema.parse(visibilitySummary).tickets.data[0]?.version).toBe(7);
  });

  it("attaches the visibility summary schema to the GET route", () => {
    expect(Reflect.getMetadata(RESPONSE_SCHEMA, ClientVisibilityController.prototype.getVisibilitySummary)).toBe(
      visibilitySummarySchema,
    );
  });

  it("keeps the selected ticket version in the service response", async () => {
    const ticketQuery = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([
              { id: 11, ticketNumber: 42, title: "Fix login", type: "BUG", clientVisible: true, version: 7 },
            ]),
          }),
        }),
      }),
    };
    const milestoneQuery = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const projectAccessQuery = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([projectAccessRow()]) }),
      }),
    };
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(projectAccessQuery)
        .mockReturnValueOnce(ticketQuery)
        .mockReturnValueOnce(milestoneQuery),
    } as unknown as Db;
    const user: CurrentUserContext = {
      userId: "user-1",
      orgId: "org-1",
      role: "OWNER",
      isOrgOwner: true,
      sessionId: "session-1",
      tokenScopes: null,
      principal: humanSessionPrincipal(7, true),
    };
    const access = principalAccess() as unknown as AccessService;
    const audit = { log: jest.fn() } as unknown as AuditService;

    const result = await new ClientVisibilityService(db, access, audit).getVisibilitySummary(user, 1);

    expect(result.tickets.data[0]?.version).toBe(7);
  });

  it("publishes the ticket version in the checked-in OpenAPI response contract", () => {
    const responseSchema = (openapi as unknown as { paths: Record<string, OpenApiObject> }).paths[
      "/build/{projectId}/client-visibility"
    ].get as OpenApiObject;
    const ticketItem = (((responseSchema.responses as OpenApiObject)["200"] as OpenApiObject).content as OpenApiObject)[
      "application/json"
    ] as OpenApiObject;
    const item = (((((ticketItem.schema as OpenApiObject).properties as OpenApiObject).data as OpenApiObject)
      .properties as OpenApiObject).tickets as OpenApiObject).properties as OpenApiObject;
    const ticketRow = ((((item.data as OpenApiObject).items as OpenApiObject)));

    expect((ticketRow.properties as OpenApiObject).version).toEqual({
      type: "integer",
      minimum: -9007199254740991,
      maximum: 9007199254740991,
    });
    expect(ticketRow.required).toContain("version");
  });
});
