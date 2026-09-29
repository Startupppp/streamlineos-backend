import type { Db } from "../../../../db/drizzle.types";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTicketRelationsService } from "./projects-ticket-relations.service";
import { BuildBlockerCreatedConsumerService } from "./build-blocker-created-consumer.service";
import { buildBlockerCreatedPayloadSchema } from "../dto/build-blocker-created-payload.schema";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import type { AddRelationInput } from "../dto/ticket-subresources.schemas";

jest.mock("./build-ticket-read-access", () => ({
  assertTicketReadAccess: jest.fn().mockResolvedValue(undefined),
}));

const ORG = "org-blocker-emit";
const PROJECT_ID = 4;
const TICKET_ID = 11;
const RELATED_ID = 12;
const RELATION_ID = 900;

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "actor-1",
  isOrgOwner: true,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
} as never;

function makeDb() {
  const tx = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([{ id: RELATION_ID, relationType: "blocks" }]),
        }),
      }),
    }),
  };
  return {
    query: {
      tickets: { findFirst: jest.fn().mockResolvedValue({ id: RELATED_ID }) },
      workItemRelations: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    }),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

async function addRelation(relationType: AddRelationInput["relationType"]) {
  const emit = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
  const service = new ProjectsTicketRelationsService(makeDb(), {
    holds: jest.fn().mockResolvedValue(true),
  } as never);
  await service.addRelation(actor, PROJECT_ID, TICKET_ID, {
    relatedTicketId: RELATED_ID,
    relationType,
  });
  const calls = emit.mock.calls.map((call) => call[1]);
  emit.mockRestore();
  return calls;
}

describe("a blocking relation emits build.blocker.created so the declared notification has a producer", () => {
  it("names the blocked ticket as the payload's blockedTicketId for relationType blocks", async () => {
    const calls = await addRelation("blocks");
    expect(calls).toHaveLength(1);
    const payload = buildBlockerCreatedPayloadSchema.parse(calls[0]?.payload);
    expect(calls[0]?.eventType).toBe("build.blocker.created");
    expect(payload.blockedTicketId).toBe(RELATED_ID);
    expect(payload.blockingTicketId).toBe(TICKET_ID);
    expect(payload.relationId).toBe(RELATION_ID);
  });

  it("inverts blocked and blocking for relationType blocked_by", async () => {
    const calls = await addRelation("blocked_by");
    expect(calls).toHaveLength(1);
    const payload = buildBlockerCreatedPayloadSchema.parse(calls[0]?.payload);
    expect(payload.blockedTicketId).toBe(TICKET_ID);
    expect(payload.blockingTicketId).toBe(RELATED_ID);
  });

  it("emits nothing for a non-blocking relation, because no consumer is declared for one", async () => {
    expect(await addRelation("relates_to")).toHaveLength(0);
    expect(await addRelation("duplicate_of")).toHaveLength(0);
  });
});

describe("the build.blocker.created consumer notifies the blocked ticket's assignees", () => {
  function makeConsumerDb(rows: { userId: string }[]) {
    return {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
        }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    } as unknown as Db;
  }

  const event = {
    eventId: "11111111-1111-4111-8111-111111111111",
    organizationId: ORG,
    aggregateType: "work_item_relation",
    aggregateId: String(RELATION_ID),
    aggregateVersion: 1,
    eventType: "build.blocker.created",
    payload: {
      relationId: RELATION_ID,
      blockedTicketId: RELATED_ID,
      blockingTicketId: TICKET_ID,
      projectId: PROJECT_ID,
      orgId: ORG,
      actorUserId: "actor-1",
    },
  } as never;

  it("dispatches build.blocker.created to the blocked ticket, not the blocking one", async () => {
    const emit = jest.fn().mockResolvedValue(undefined);
    const service = new BuildBlockerCreatedConsumerService(
      makeConsumerDb([{ userId: "assignee-9" }]),
      { emit } as never,
      { register: jest.fn() } as never,
    );
    await service.handle(event);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "build.blocker.created",
        entityId: String(RELATED_ID),
        targetUserIds: ["assignee-9"],
      }),
    );
  });

  it("dispatches nothing when the blocked ticket has no assignee but the actor", async () => {
    const emit = jest.fn().mockResolvedValue(undefined);
    const service = new BuildBlockerCreatedConsumerService(
      makeConsumerDb([]),
      { emit } as never,
      { register: jest.fn() } as never,
    );
    await service.handle(event);
    expect(emit).not.toHaveBeenCalled();
  });

  it("declares the event type the producer emits", () => {
    const service = new BuildBlockerCreatedConsumerService(
      makeConsumerDb([]),
      { emit: jest.fn() } as never,
      { register: jest.fn() } as never,
    );
    expect(service.eventType).toBe("build.blocker.created");
  });
});
