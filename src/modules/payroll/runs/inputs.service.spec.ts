import { ForbiddenException } from "@nestjs/common";
import { InputsService } from "./inputs.service";

describe("InputsService.listInputs scope gate", () => {
  const orgId = "org-1";
  const runId = 10;
  const actorUserId = "actor-1";

  function createService(options: { rows?: unknown[]; run?: { id: number; status: string } | null }) {
    const resolved = options.rows ?? [];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(options.run ? [options.run] : []),
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue(resolved),
                  }),
                }),
              }),
            }),
          }),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                  offset: jest.fn().mockResolvedValue(resolved),
                }),
              }),
            }),
          }),
        }),
      }),
    };
    return new InputsService(db as never);
  }

  it("rejects cross-user filter when scope is not all", async () => {
    const service = createService({ run: { id: runId, status: "PREPARING" } });
    await expect(
      service.listInputs(orgId, runId, { page: 1, limit: 50, userId: "other-user" }, "own", actorUserId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows cross-user filter when scope is all", async () => {
    const service = createService({ run: { id: runId, status: "PREPARING" }, rows: [] });
    await expect(
      service.listInputs(orgId, runId, { page: 1, limit: 50, userId: "other-user" }, "all", actorUserId),
    ).resolves.toEqual([]);
  });
});
