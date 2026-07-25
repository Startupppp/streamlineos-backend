import { BadRequestException } from "@nestjs/common";
import { KbImportExportService } from "./kb-import-export.service";
import type { Db } from "../../db/drizzle.module";
import type { AuditService } from "../../common/audit/audit.service";
import type { PlanLimitsService } from "../billing/plan-limits.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { ImportPagesInput } from "./dto/kb-import-export.schemas";

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-A",
    role: "member",
    isOrgOwner: false,
    isPlatformAdmin: false,
    permissions: ["kb:pages:import"],
    enabledModules: ["kb"],
  } as unknown as CurrentUserContext;
}

describe("KbImportExportService.importPages parent validation", () => {
  it("rejects a parentPageId that does not belong to the caller's org", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const db = { select } as unknown as Db;

    const audit = { log: jest.fn() } as unknown as AuditService;
    const planLimits = {
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlanLimitsService;

    const service = new KbImportExportService(db, audit, planLimits);

    const input: ImportPagesInput = {
      sourceType: "markdown",
      items: [{ title: "X", contentText: "y", parentPageId: 999 }],
    } as unknown as ImportPagesInput;

    await expect(service.importPages(makeUser(), input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith("org-A", "kbPages", 1);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
