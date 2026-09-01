import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";
import { InvitationsReadService } from "./invitations-read.service";
import { OrgMembershipReadService } from "./org-membership-read.service";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

function makeDb(rowsByCall: unknown[][], captured: { where: unknown[]; orderBy: unknown[][]; limits: number[] }) {
  let call = 0;
  return {
    select: jest.fn(() => {
      const rows = rowsByCall[call++] ?? [];
      const builder: Record<string, unknown> = {
        from: jest.fn(),
        where: jest.fn((condition: unknown) => {
          captured.where.push(condition);
          return builder;
        }),
        innerJoin: jest.fn(),
        orderBy: jest.fn((...columns: unknown[]) => {
          captured.orderBy.push(columns);
          return builder;
        }),
        limit: jest.fn((limit: number) => {
          captured.limits.push(limit);
          return Promise.resolve(rows);
        }),
      };
      for (const method of ["from", "innerJoin"]) {
        (builder[method] as jest.Mock).mockReturnValue(builder);
      }
      return builder;
    }),
  } as unknown as Db;
}

describe("organization core read pagination", () => {
  it("pages invitations newest-first with an id tie-breaker and a sentinel", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const rows = ["i-1", "i-2", "i-3"].map((id) => ({ id, createdAt }));
    const captured = { where: [] as unknown[], orderBy: [] as unknown[][], limits: [] as number[] };
    const service = new InvitationsReadService(makeDb([rows, []], captured));

    const first = await service.listPaginated("org-1", { limit: 2 });
    expect(first.data.map((row) => row.id)).toEqual(["i-1", "i-2"]);
    expect(first.pagination).toMatchObject({ limit: 2, hasMore: true });
    expect(first.pagination.nextCursor).toEqual(expect.any(String));
    expect(captured.limits).toEqual([3]);
    expect(captured.orderBy[0]).toHaveLength(2);

    await service.listPaginated("org-1", { limit: 2, cursor: first.pagination.nextCursor ?? undefined });
    expect(render(captured.where[1])).toMatch(/</);
  });

  it("rejects malformed or filter-mismatched invitation cursors with 400", async () => {
    const captured = { where: [] as unknown[], orderBy: [] as unknown[][], limits: [] as number[] };
    const service = new InvitationsReadService(makeDb([[]], captured));

    await expect(service.listPaginated("org-1", { cursor: "not-a-cursor" })).rejects.toBeInstanceOf(BadRequestException);
    const cursor = encodeCursor({
      sortValue: new Date().toISOString(),
      id: JSON.stringify(["other-org", false, null, null, "i-1"]),
    });
    await expect(service.listPaginated("org-1", { cursor })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("pages members by display name and membership id with a sentinel", async () => {
    const rows = [
      { membershipId: 1, userId: "u-1", name: "Ada", email: "ada@example.com" },
      { membershipId: 2, userId: "u-2", name: "Ada", email: "ada-2@example.com" },
      { membershipId: 3, userId: "u-3", name: "Bea", email: "bea@example.com" },
    ];
    const captured = { where: [] as unknown[], orderBy: [] as unknown[][], limits: [] as number[] };
    const service = new OrgMembershipReadService(makeDb([rows, []], captured));

    const first = await service.list("org-1", undefined, 2, undefined, undefined, false);
    expect(first.data.map((row) => row.membershipId)).toEqual([1, 2]);
    expect(first.pagination).toMatchObject({ limit: 2, hasMore: true });
    expect(first.pagination.nextCursor).toEqual(expect.any(String));
    expect(captured.limits).toEqual([3]);
    expect(captured.orderBy[0]).toHaveLength(2);

    await service.list("org-1", first.pagination.nextCursor ?? undefined, 2, undefined, undefined, false);
    expect(render(captured.where[1])).toMatch(/>/);
  });

  it("rejects malformed or filter-mismatched member cursors with 400", async () => {
    const captured = { where: [] as unknown[], orderBy: [] as unknown[][], limits: [] as number[] };
    const service = new OrgMembershipReadService(makeDb([[]], captured));

    await expect(service.list("org-1", "not-a-cursor", 20, undefined, undefined, false)).rejects.toBeInstanceOf(BadRequestException);
    const cursor = encodeCursor({
      sortValue: "Ada",
      id: JSON.stringify(["org-1", "Ada", null, false, 1]),
    });
    await expect(service.list("org-1", cursor, 20, undefined, undefined, false)).rejects.toBeInstanceOf(BadRequestException);
  });
});
