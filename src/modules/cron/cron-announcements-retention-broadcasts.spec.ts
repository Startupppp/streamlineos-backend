import { forEachOrg } from "../../common/tenant";
import type { Db } from "../../db/drizzle.module";
import { CronAnnouncementsRetentionService } from "./cron-announcements-retention.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

const forEachOrgMock = forEachOrg as unknown as jest.Mock;

interface Chain extends Promise<unknown[]> {
  where: (w: unknown) => Chain;
  returning: () => Chain;
}

function sqlText(node: unknown): string {
  const shape = node as { queryChunks?: unknown[] };
  return (shape.queryChunks ?? [])
    .map((chunk) => {
      const part = chunk as { value?: unknown };
      return Array.isArray(part.value) ? part.value.join("") : "";
    })
    .join(" ");
}

async function sweepAndCaptureSql(): Promise<string[]> {
  const captured: unknown[] = [];
  const chain: Chain = Object.assign(Promise.resolve([]), {
    where: (w: unknown) => {
      captured.push(w);
      return chain;
    },
    returning: () => chain,
  });
  const tx = { delete: () => chain, insert: () => ({ values: async () => undefined }) };

  forEachOrgMock.mockImplementation(
    async (_db: unknown, _name: string, run: (tx: unknown, orgId: string) => Promise<void>) => {
      await run(tx, "org-a");
      return { organizations: 1, failed: 0 };
    },
  );

  const svc = new CronAnnouncementsRetentionService({} as unknown as Db);
  await svc.sweep();
  return captured.map(sqlText);
}

describe("announcements retention sweeps broadcasts now that broadcasts is the only writer", () => {
  it("deletes from broadcasts and never from the retired announcements table", async () => {
    const statements = await sweepAndCaptureSql();

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement).toContain("FROM broadcasts");
      expect(statement).not.toContain("FROM announcements");
    }
  });

  it("reads the author from created_by, because broadcasts has no author_id and a missing column would abort the sweep", async () => {
    const statements = await sweepAndCaptureSql();

    for (const statement of statements) {
      expect(statement).toContain("created_by NOT IN");
      expect(statement).not.toContain("author_id NOT IN");
    }
  });

  it("reaps only org-wide broadcasts, so a department-targeted or role-targeted broadcast is never swept by announcement retention", async () => {
    const statements = await sweepAndCaptureSql();

    for (const statement of statements) {
      expect(statement).toContain("audience_type = 'all'");
    }
  });

  it("still keeps its two phases, one on expires_at and one on created_at, which is the positive control for the exclusions above", async () => {
    const statements = await sweepAndCaptureSql();

    expect(statements.some((s) => s.includes("expires_at IS NOT NULL"))).toBe(true);
    expect(statements.some((s) => s.includes("created_at <"))).toBe(true);
  });

  it("still excludes an author under an active legal hold", async () => {
    const statements = await sweepAndCaptureSql();

    for (const statement of statements) {
      expect(statement).toContain("hr_legal_holds");
      expect(statement).toContain("status = 'active'");
    }
  });
});
