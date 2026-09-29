import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { WhiteboardsService } from "./whiteboards.service";
import { lifecycleAuditDouble } from "../lifecycle/audit-double";

describe("WhiteboardsService.listWhiteboards — cursor pagination", () => {
  const ORG_ID = "org-wb-test";
  const PROJECT_ID = 5;

  const access = { holds: jest.fn().mockResolvedValue(true) } as never;

  function makeRow(id: number) {
    return {
      id,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      name: `Board ${id}`,
      data: { elements: [{ id: "e1" }] },
      visibility: "project",
      createdBy: "u1",
      updatedAt: new Date(Date.UTC(2026, 0, id)),
    };
  }

  function makeDb(projectRow: unknown | null, boardRows: unknown[]) {
    const limitFn = jest.fn().mockResolvedValue(boardRows);
    const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
    const boardWhere = jest.fn().mockReturnValue({ orderBy: orderByFn });
    const leftJoin = jest.fn().mockReturnValue({ where: boardWhere });
    const from = jest.fn().mockReturnValue({ leftJoin });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  const makeU = (orgId: string) =>
    ({ orgId, userId: "u1", isOrgOwner: true } as never);

  it("returns hasMore:true and nextCursor when the page is full and more rows exist", async () => {
    const overflow = Array.from({ length: 21 }, (_, i) => makeRow(21 - i));
    const db = makeDb({ id: PROJECT_ID }, overflow);
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const result = await svc.listWhiteboards(makeU(ORG_ID), PROJECT_ID, { limit: 20 });

    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).toBeTruthy();
    expect(result.data).toHaveLength(20);
  });

  it("trims the sentinel row so data.length equals limit", async () => {
    const overflow = Array.from({ length: 21 }, (_, i) => makeRow(21 - i));
    const db = makeDb({ id: PROJECT_ID }, overflow);
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const result = await svc.listWhiteboards(makeU(ORG_ID), PROJECT_ID, { limit: 20 });

    expect(result.data).toHaveLength(20);
    expect(result.data[19]?.id).not.toBe(overflow[20]?.id);
  });

  it("returns hasMore:false and nextCursor:null when rows fit in one page", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(5 - i));
    const db = makeDb({ id: PROJECT_ID }, rows);
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const result = await svc.listWhiteboards(makeU(ORG_ID), PROJECT_ID, { limit: 20 });

    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.data).toHaveLength(5);
  });

  it("returns elementCount from data.elements.length", async () => {
    const row = makeRow(1);
    const db = makeDb({ id: PROJECT_ID }, [row]);
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const result = await svc.listWhiteboards(makeU(ORG_ID), PROJECT_ID, { limit: 20 });

    expect(result.data[0]?.elementCount).toBe(1);
  });

  it("throws NotFoundException when project is not found — assertProject gate", async () => {
    const db = makeDb(null, []);
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    await expect(
      svc.listWhiteboards(makeU(ORG_ID), PROJECT_ID, { limit: 20 }),
    ).rejects.toThrow(NotFoundException);
  });

  it("queries with limit + 1 to detect the next page sentinel", async () => {
    const rows: unknown[] = [];
    const limitFn = jest.fn().mockResolvedValue(rows);
    const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
    const boardWhere = jest.fn().mockReturnValue({ orderBy: orderByFn });
    const leftJoin = jest.fn().mockReturnValue({ where: boardWhere });
    const from = jest.fn().mockReturnValue({ leftJoin });
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: PROJECT_ID }) } },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    await svc.listWhiteboards(makeU(ORG_ID), PROJECT_ID, { limit: 20 });

    expect(limitFn).toHaveBeenCalledWith(21);
  });
});
