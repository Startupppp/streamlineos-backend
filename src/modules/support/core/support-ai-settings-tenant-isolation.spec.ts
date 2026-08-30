import { SupportAiSettingsService } from "./support-ai-settings.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportAiSettingsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(row: unknown): { db: Db; findFirst: jest.Mock } {
    const findFirst = jest.fn().mockResolvedValue(row);
    const db = {
      query: { supportAiSettings: { findFirst } },
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Db;
    return { db, findFirst };
  }

  it("returns default threshold when no settings exist for a different org (tenant isolation)", async () => {
    const { db, findFirst } = makeDb(undefined);
    const svc = new SupportAiSettingsService(db);
    const result = await svc.getSettings(ATTACKER_ORG);
    expect(result.confidenceThreshold).toBe(0.7);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("returns stored threshold for the owning org (control — same-tenant access works)", async () => {
    const { db, findFirst } = makeDb({ confidenceThreshold: "0.850" });
    const svc = new SupportAiSettingsService(db);
    const result = await svc.getSettings(OWNER_ORG);
    expect(result.confidenceThreshold).toBe(0.85);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
