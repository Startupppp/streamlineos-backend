import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { SprintsService } from "./sprints.service";

describe("Sprint missing-resource writes", () => {
  it("rejects an unknown sprint before updating", async () => {
    const update = jest.fn(() => ({ set: () => ({ where: async () => [] }) }));
    const module = await Test.createTestingModule({ providers: [SprintsService, {
      provide: DRIZZLE,
      useValue: {
        query: { sprints: { findFirst: async () => undefined } },
        transaction: async (run: (tx: { update: typeof update }) => Promise<void>) => run({ update }),
      },
    }] }).compile();
    await expect(module.get(SprintsService).updateSprint("org-a", 1, 77, { name: "Changed" }))
      .rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
    await module.close();
  });
});
