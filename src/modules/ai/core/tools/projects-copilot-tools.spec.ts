import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ProjectsCopilotTools } from "./projects-copilot-tools";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";

describe("ProjectsCopilotTools — createTicket input schema", () => {
  let svc: ProjectsCopilotTools;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        ProjectsCopilotTools,
        { provide: DRIZZLE, useValue: {} },
        { provide: AiConfirmationService, useValue: {} },
      ],
    }).compile();
    svc = mod.get(ProjectsCopilotTools);
  });

  it("accepts every value in the DB ticket_type enum", () => {
    const tool = svc.tools().find((t) => t.key === "createTicket");
    expect(tool).toBeDefined();
    for (const type of ["TASK", "STORY", "BUG", "EPIC"]) {
      const result = tool!.input.safeParse({ projectId: 1, title: "Test ticket", type });
      expect(result.success).toBe(true);
    }
  });

  it("rejects SUBTASK which is absent from the DB ticket_type enum", () => {
    const tool = svc.tools().find((t) => t.key === "createTicket");
    expect(tool).toBeDefined();
    const result = tool!.input.safeParse({ projectId: 1, title: "Test ticket", type: "SUBTASK" });
    expect(result.success).toBe(false);
  });
});
