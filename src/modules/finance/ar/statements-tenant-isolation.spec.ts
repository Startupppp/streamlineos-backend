import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { StatementsService } from "./statements.service";

describe("StatementsService — cross-tenant isolation", () => {
  it("throws NotFoundException when the client belongs to a different org (BOLA isolation)", async () => {
    const db = {
      query: {
        clients: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as Db;
    const svc = new StatementsService(db);

    await expect(svc.customerStatement("org-attacker", 99, {})).rejects.toThrow(NotFoundException);
  });

  it("proceeds for the owning org when the client exists (same-tenant control)", async () => {
    const client = { id: 99, name: "Acme Corp" };
    const db = {
      query: {
        clients: {
          findFirst: jest.fn().mockResolvedValue(client),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
            then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new StatementsService(db);

    const result = await svc.customerStatement("org-owner", 99, {});

    expect(result).toBeDefined();
  });
});
