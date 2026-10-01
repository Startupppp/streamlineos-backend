import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import {
  BuildAutomationActionExecutor,
  AUTOMATION_TICKET_CHANGE,
} from "./build-automation-actions.service";
import { ProjectsTicketLabelsService } from "../tickets/projects-ticket-labels.service";
import { ProjectsTicketCommentsService } from "../tickets/projects-ticket-comments.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { TicketVersionConflictException } from "../tickets/ticket-version-conflict.exception";
import { ProjectsInvalidTicketStatusException } from "../../../../common/http/api-exceptions";

const ORG = "org-canonical";
const PROJECT = 5;
const TICKET = 42;
const AUTHOR = "user-auto";

function makeLabelDb(labelId: number | null) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(labelId !== null ? [{ id: labelId }] : []),
      }),
    }),
  };
}

async function buildModule(opts: {
  labelId?: number | null;
  updateTicketFn?: jest.Mock;
  addTicketLabelFn?: jest.Mock;
  addCommentFn?: jest.Mock;
}): Promise<{
  executor: BuildAutomationActionExecutor;
  updateTicketFn: jest.Mock;
  addTicketLabelFn: jest.Mock;
  addCommentFn: jest.Mock;
}> {
  const updateTicketFn = opts.updateTicketFn ?? jest.fn().mockResolvedValue({});
  const addTicketLabelFn = opts.addTicketLabelFn ?? jest.fn().mockResolvedValue({ success: true });
  const addCommentFn = opts.addCommentFn ?? jest.fn().mockResolvedValue({});
  const labelId = opts.labelId !== undefined ? opts.labelId : 77;

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BuildAutomationActionExecutor,
      { provide: DRIZZLE, useValue: makeLabelDb(labelId) },
      { provide: AUTOMATION_TICKET_CHANGE, useValue: { updateTicket: updateTicketFn } },
      { provide: ProjectsTicketLabelsService, useValue: { addTicketLabel: addTicketLabelFn } },
      { provide: ProjectsTicketCommentsService, useValue: { addComment: addCommentFn } },
    ],
  }).compile();

  return {
    executor: module.get(BuildAutomationActionExecutor),
    updateTicketFn,
    addTicketLabelFn,
    addCommentFn,
  };
}

function systemJobActorShape(orgId: string, userId: string) {
  return expect.objectContaining({
    orgId,
    userId,
    isOrgOwner: false,
    principal: expect.objectContaining({
      kind: "system-job",
      jobId: "build.automation.apply-action",
    }),
  });
}

describe("BuildAutomationActionExecutor — set_status routes to canonical ticket-change owner", () => {
  it("calls updateTicket with a system-job actor carrying the calling org and author", async () => {
    const { executor, updateTicketFn } = await buildModule({});

    await executor.execute(ORG, PROJECT, TICKET, { type: "set_status", value: "IN_PROGRESS" }, AUTHOR);

    expect(updateTicketFn).toHaveBeenCalledWith(
      systemJobActorShape(ORG, AUTHOR),
      PROJECT,
      TICKET,
      { status: "IN_PROGRESS" },
    );
  });

  it("does not call addTicketLabel or addComment when set_status succeeds", async () => {
    const { executor, addTicketLabelFn, addCommentFn } = await buildModule({});

    await executor.execute(ORG, PROJECT, TICKET, { type: "set_status", value: "DONE" }, AUTHOR);

    expect(addTicketLabelFn).not.toHaveBeenCalled();
    expect(addCommentFn).not.toHaveBeenCalled();
  });

  it("propagates TicketVersionConflictException thrown by updateTicket", async () => {
    const { executor } = await buildModule({
      updateTicketFn: jest.fn().mockRejectedValue(new TicketVersionConflictException(3)),
    });

    await expect(
      executor.execute(ORG, PROJECT, TICKET, { type: "set_status", value: "DONE" }, AUTHOR),
    ).rejects.toBeInstanceOf(TicketVersionConflictException);
  });

  it("propagates ProjectsInvalidTicketStatusException thrown by updateTicket", async () => {
    const { executor } = await buildModule({
      updateTicketFn: jest.fn().mockRejectedValue(new ProjectsInvalidTicketStatusException("UNKNOWN")),
    });

    await expect(
      executor.execute(ORG, PROJECT, TICKET, { type: "set_status", value: "UNKNOWN" }, AUTHOR),
    ).rejects.toBeInstanceOf(ProjectsInvalidTicketStatusException);
  });

  it("propagates ConflictException (WIP limit exceeded) thrown by updateTicket", async () => {
    const { executor } = await buildModule({
      updateTicketFn: jest.fn().mockRejectedValue(new ConflictException("Column exceeds WIP limit")),
    });

    await expect(
      executor.execute(ORG, PROJECT, TICKET, { type: "set_status", value: "IN_PROGRESS" }, AUTHOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("BuildAutomationActionExecutor — set_priority routes to canonical ticket-change owner", () => {
  it("calls updateTicket with priority payload when the value is a valid priority", async () => {
    const { executor, updateTicketFn } = await buildModule({});

    await executor.execute(ORG, PROJECT, TICKET, { type: "set_priority", value: "HIGH" }, AUTHOR);

    expect(updateTicketFn).toHaveBeenCalledWith(
      systemJobActorShape(ORG, AUTHOR),
      PROJECT,
      TICKET,
      { priority: "HIGH" },
    );
  });

  it("throws BadRequestException before calling updateTicket when the priority value is invalid", async () => {
    const { executor, updateTicketFn } = await buildModule({});

    await expect(
      executor.execute(ORG, PROJECT, TICKET, { type: "set_priority", value: "WHATEVER" }, AUTHOR),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(updateTicketFn).not.toHaveBeenCalled();
  });
});

describe("BuildAutomationActionExecutor — set_assignee routes to canonical ticket-change owner", () => {
  it("calls updateTicket with assigneeId payload", async () => {
    const { executor, updateTicketFn } = await buildModule({});

    await executor.execute(ORG, PROJECT, TICKET, { type: "set_assignee", value: "user-x" }, AUTHOR);

    expect(updateTicketFn).toHaveBeenCalledWith(
      systemJobActorShape(ORG, AUTHOR),
      PROJECT,
      TICKET,
      { assigneeId: "user-x" },
    );
  });

  it("propagates NotFoundException thrown by updateTicket when the assignee is not a project member", async () => {
    const { executor } = await buildModule({
      updateTicketFn: jest.fn().mockRejectedValue(new NotFoundException("User is not a project member")),
    });

    await expect(
      executor.execute(ORG, PROJECT, TICKET, { type: "set_assignee", value: "outsider" }, AUTHOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("BuildAutomationActionExecutor — add_label resolves label id then routes to labels service", () => {
  it("resolves the label by numeric id and calls addTicketLabel with it", async () => {
    const { executor, addTicketLabelFn } = await buildModule({ labelId: 77 });

    await executor.execute(ORG, PROJECT, TICKET, { type: "add_label", value: "77" }, AUTHOR);

    expect(addTicketLabelFn).toHaveBeenCalledWith(
      systemJobActorShape(ORG, AUTHOR),
      PROJECT,
      TICKET,
      { labelId: 77 },
    );
  });

  it("resolves the label by name and calls addTicketLabel with the resolved id", async () => {
    const { executor, addTicketLabelFn } = await buildModule({ labelId: 99 });

    await executor.execute(ORG, PROJECT, TICKET, { type: "add_label", value: "bug" }, AUTHOR);

    expect(addTicketLabelFn).toHaveBeenCalledWith(
      systemJobActorShape(ORG, AUTHOR),
      PROJECT,
      TICKET,
      { labelId: 99 },
    );
  });

  it("throws NotFoundException and does not call addTicketLabel when the label does not exist", async () => {
    const { executor, addTicketLabelFn } = await buildModule({ labelId: null });

    await expect(
      executor.execute(ORG, PROJECT, TICKET, { type: "add_label", value: "99" }, AUTHOR),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(addTicketLabelFn).not.toHaveBeenCalled();
  });
});

describe("BuildAutomationActionExecutor — add_comment routes to comments service", () => {
  it("calls addComment with the rule author as actor when authorId is provided", async () => {
    const { executor, addCommentFn } = await buildModule({});

    await executor.execute(ORG, PROJECT, TICKET, { type: "add_comment", value: "hello" }, AUTHOR);

    expect(addCommentFn).toHaveBeenCalledWith(
      systemJobActorShape(ORG, AUTHOR),
      PROJECT,
      TICKET,
      { content: "hello" },
    );
  });

  it("throws BadRequestException and does not call addComment when authorId is null", async () => {
    const { executor, addCommentFn } = await buildModule({});

    await expect(
      executor.execute(ORG, PROJECT, TICKET, { type: "add_comment", value: "hello" }, null),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(addCommentFn).not.toHaveBeenCalled();
  });
});

describe("BuildAutomationActionExecutor — actor userId equals the rule author, not a fixed system value", () => {
  it("sets userId to the supplied authorId, not to 'system'", async () => {
    const { executor, updateTicketFn } = await buildModule({});

    await executor.execute(ORG, PROJECT, TICKET, { type: "set_status", value: "DONE" }, "rule-author-abc");

    expect(updateTicketFn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "rule-author-abc" }),
      PROJECT,
      TICKET,
      { status: "DONE" },
    );
  });

  it("sets userId to 'system' when authorId is null (add_comment excluded — it throws first)", async () => {
    const { executor, updateTicketFn } = await buildModule({});

    await executor.execute(ORG, PROJECT, TICKET, { type: "set_status", value: "DONE" }, null);

    expect(updateTicketFn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "system" }),
      PROJECT,
      TICKET,
      { status: "DONE" },
    );
  });
});
