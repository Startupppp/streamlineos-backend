import { getTableConfig } from "drizzle-orm/pg-core";
import { projectApprovals } from "../../../db/schema";
import { BuildApprovalsInboxService } from "./build-approvals-inbox.service";
import type { Db } from "../../../db/drizzle.module";

const INDEX_NAME = "idx_project_approvals_approver_created_id";

interface IndexColumn {
  name: string;
  order: string;
}

function indexColumns(name: string): IndexColumn[] {
  const idx = getTableConfig(projectApprovals).indexes.find((i) => i.config.name === name);
  const columns = idx?.config.columns ?? [];
  return columns.map((column) => {
    const typed = column as { name?: string; indexConfig?: { order?: string } };
    return { name: typed.name ?? "", order: typed.indexConfig?.order ?? "" };
  });
}

function indexWhere(name: string): unknown {
  return getTableConfig(projectApprovals).indexes.find((i) => i.config.name === name)?.config.where;
}

function orderByColumns(args: unknown[]): IndexColumn[] {
  return args.map((arg) => {
    const chunks = (arg as { queryChunks?: unknown[] }).queryChunks ?? [];
    let name = "";
    let order = "asc";
    for (const chunk of chunks) {
      const asColumn = chunk as { name?: string };
      if (typeof asColumn.name === "string") name = asColumn.name;
      const value = (chunk as { value?: unknown }).value;
      const text = Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : "";
      if (text.toLowerCase().includes("desc")) order = "desc";
    }
    return { name, order };
  });
}

async function captureOrderBy(): Promise<IndexColumn[]> {
  const captured: unknown[] = [];
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockImplementation((...args: unknown[]) => {
    captured.push(...args);
    return { limit };
  });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  await new BuildApprovalsInboxService(db).getInboxPage("org-1", "user-1", 42, 20, null);
  return orderByColumns(captured);
}

describe("A7 — the approvals inbox keyset index still matches the read it was built for", () => {
  it("walks a real index list and a real ORDER BY, so a later comparison cannot pass on two empties", async () => {
    expect(getTableConfig(projectApprovals).indexes.length).toBeGreaterThan(3);
    expect(indexColumns(INDEX_NAME)).toHaveLength(5);
    expect(await captureOrderBy()).toHaveLength(2);
  });

  it("leads with the two equality columns the inbox predicate pins", () => {
    const columns = indexColumns(INDEX_NAME);
    expect(columns[0]).toEqual({ name: "org_id", order: "asc" });
    expect(columns[1]).toEqual({ name: "approver_membership_id", order: "asc" });
  });

  it("carries created_at then id immediately after the equality columns, with nothing between them", () => {
    const columns = indexColumns(INDEX_NAME);
    expect(columns[2]?.name).toBe("created_at");
    expect(columns[3]?.name).toBe("id");
  });

  it("trails status after the ordering columns, so the two-value IN filters inside one range", () => {
    expect(indexColumns(INDEX_NAME)[4]?.name).toBe("status");
  });

  it("is partial on deleted_at so it matches the read's own soft-delete predicate", () => {
    expect(indexWhere(INDEX_NAME)).toBeDefined();
  });

  it("orders created_at and id in the same directions getInboxPage sorts by, or the sort is not index-served", async () => {
    const sort = await captureOrderBy();
    const columns = indexColumns(INDEX_NAME);
    expect(sort).toEqual([
      { name: "created_at", order: "desc" },
      { name: "id", order: "desc" },
    ]);
    expect([columns[2], columns[3]]).toEqual(sort);
  });

  it("keeps the narrower approver/status index, which this wider one does not make redundant", () => {
    const names = getTableConfig(projectApprovals).indexes.map((i) => i.config.name);
    expect(names).toContain("idx_project_approvals_approver_status");
  });
});
