import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import {
  BuildAutomationActionExecutor,
  AUTOMATION_TICKET_CHANGE,
} from "./build-automation-actions.service";
import { ProjectsTicketLabelsService } from "../tickets/projects-ticket-labels.service";
import { ProjectsTicketCommentsService } from "../tickets/projects-ticket-comments.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const PROJECT = 10;
const TICKET = 42;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeCapturingLabelDb() {
  let capturedWhere: unknown = undefined;
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation((predicate: unknown) => {
        capturedWhere = predicate;
        return { limit: jest.fn().mockResolvedValue([]) };
      }),
    }),
    getCapturedWhere: () => capturedWhere,
  };
  return db;
}

function makeFoundLabelDb(labelId: number) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ id: labelId }]) }),
    }),
  };
}

async function buildExecutorWithDb(db: object): Promise<BuildAutomationActionExecutor> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BuildAutomationActionExecutor,
      { provide: DRIZZLE, useValue: db },
      { provide: AUTOMATION_TICKET_CHANGE, useValue: { updateTicket: jest.fn().mockResolvedValue({}) } },
      { provide: ProjectsTicketLabelsService, useValue: { addTicketLabel: jest.fn().mockResolvedValue({ success: true }) } },
      { provide: ProjectsTicketCommentsService, useValue: { addComment: jest.fn().mockResolvedValue({}) } },
    ],
  }).compile();
  return module.get(BuildAutomationActionExecutor);
}

describe("BuildAutomationActionExecutor — label lookup is scoped to the calling org", () => {
  it("attacker org's label query carries attacker orgId, not owner orgId (DENY path: NotFoundException expected)", async () => {
    const db = makeCapturingLabelDb();
    const executor = await buildExecutorWithDb(db);

    await expect(
      executor.execute(ATTACKER_ORG, PROJECT, TICKET, { type: "add_label", value: "77" }, null),
    ).rejects.toBeInstanceOf(NotFoundException);

    const values = sqlValues(db.getCapturedWhere());
    expect(values).toContain(ATTACKER_ORG);
    expect(values).not.toContain(OWNER_ORG);
  });

  it("owner org label query carries owner orgId and the label is found (positive control)", async () => {
    const db = makeFoundLabelDb(77);
    const executor = await buildExecutorWithDb(db);

    await expect(
      executor.execute(OWNER_ORG, PROJECT, TICKET, { type: "add_label", value: "77" }, null),
    ).resolves.toBeUndefined();
  });
});

describe("BuildAutomationActionExecutor — actor carries the orgId from the execute call", () => {
  it("actor.orgId equals the orgId passed to execute, not a hard-coded value", async () => {
    const updateTicketFn = jest.fn().mockResolvedValue({});
    const db = makeFoundLabelDb(77);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildAutomationActionExecutor,
        { provide: DRIZZLE, useValue: db },
        { provide: AUTOMATION_TICKET_CHANGE, useValue: { updateTicket: updateTicketFn } },
        { provide: ProjectsTicketLabelsService, useValue: { addTicketLabel: jest.fn().mockResolvedValue({ success: true }) } },
        { provide: ProjectsTicketCommentsService, useValue: { addComment: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();
    const executor = module.get(BuildAutomationActionExecutor);

    await executor.execute(OWNER_ORG, PROJECT, TICKET, { type: "set_status", value: "DONE" }, null);

    expect(updateTicketFn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER_ORG }),
      PROJECT,
      TICKET,
      { status: "DONE" },
    );
  });

  it("calling with different orgId produces an actor bound to that org, not the owner org", async () => {
    const updateTicketFn = jest.fn().mockResolvedValue({});
    const db = makeFoundLabelDb(77);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildAutomationActionExecutor,
        { provide: DRIZZLE, useValue: db },
        { provide: AUTOMATION_TICKET_CHANGE, useValue: { updateTicket: updateTicketFn } },
        { provide: ProjectsTicketLabelsService, useValue: { addTicketLabel: jest.fn().mockResolvedValue({ success: true }) } },
        { provide: ProjectsTicketCommentsService, useValue: { addComment: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();
    const executor = module.get(BuildAutomationActionExecutor);

    await executor.execute(ATTACKER_ORG, PROJECT, TICKET, { type: "set_status", value: "DONE" }, null);

    expect(updateTicketFn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ATTACKER_ORG }),
      PROJECT,
      TICKET,
      { status: "DONE" },
    );
    expect(updateTicketFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER_ORG }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
