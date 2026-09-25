import { HttpException, NotFoundException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { EntitlementsService } from "../../access/entitlements.service";
import { KbHrLinkFlagsService } from "./kb-hr-link-flags.service";

const actor: CurrentUserContext = {
  userId: "admin-1",
  orgId: "org-flags",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

interface Stored {
  hrmsKbLinkEnabled: boolean;
  hrmsKbSearchEnabled: boolean;
  hrmsKbAiEnabled: boolean;
}

function harness(stored: Stored | undefined, hrEnabled = true) {
  const written: Record<string, unknown>[] = [];
  const insertChain: { values: jest.Mock; onConflictDoUpdate: jest.Mock } = {
    values: jest.fn((row: Record<string, unknown>) => {
      written.push(row);
      return insertChain;
    }),
    onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
  };
  const findFirst = jest.fn().mockResolvedValue(stored);
  const db = { query: { kbSettings: { findFirst } }, insert: jest.fn(() => insertChain) } as unknown as Db;
  const isModuleEnabled = jest.fn().mockResolvedValue(hrEnabled);
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const service = new KbHrLinkFlagsService(
    db,
    { isModuleEnabled } as unknown as EntitlementsService,
    audit as unknown as AuditService,
  );
  return { service, written, audit, isModuleEnabled, findFirst, insert: db.insert as unknown as jest.Mock };
}

const ROW = (link: boolean, search: boolean, ai: boolean): Stored => ({
  hrmsKbLinkEnabled: link,
  hrmsKbSearchEnabled: search,
  hrmsKbAiEnabled: ai,
});

describe("KbHrLinkFlagsService — reading", () => {
  it("is all off for a tenant with no settings row", async () => {
    const { service } = harness(undefined);

    await expect(service.getEffective("org-flags")).resolves.toEqual({ link: false, search: false, ai: false });
  });

  it("does not even ask whether HR is enabled while linking is off", async () => {
    const { service, isModuleEnabled } = harness(ROW(false, true, true));

    await expect(service.getEffective("org-flags")).resolves.toEqual({ link: false, search: false, ai: false });
    expect(isModuleEnabled).not.toHaveBeenCalled();
  });

  it("is all off when HR is not enabled, whatever is stored", async () => {
    const { service } = harness(ROW(true, true, true), false);

    await expect(service.getEffective("org-flags")).resolves.toEqual({ link: false, search: false, ai: false });
  });

  it("lets each switch count only when the one before it is on, even if a row says otherwise", async () => {
    await expect(harness(ROW(true, false, true)).service.getEffective("o")).resolves.toEqual({ link: true, search: false, ai: false });
    await expect(harness(ROW(true, true, true)).service.getEffective("o")).resolves.toEqual({ link: true, search: true, ai: true });
  });

  it("answers 404 for a disabled switch, so the feature looks absent", async () => {
    const { service } = harness(ROW(true, false, false));

    await expect(service.assertEnabled("org-flags", "search")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.assertEnabled("org-flags", "link")).resolves.toBeUndefined();
  });

  /**
   * V-140. The 404 is right; a BARE 404 is not. It reached the client as the filter's default `NOT_FOUND`,
   * indistinguishable from a document that was deleted, so nothing could tell an administrator "your
   * organisation has this switched off" rather than "that is gone".
   */
  it("carries a FEATURE_DISABLED code, and a message that names neither the flag nor the organisation", async () => {
    const { service } = harness(ROW(true, false, false));

    const error = await service.assertEnabled("org-flags", "search").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(NotFoundException);
    const body = (error as NotFoundException).getResponse();
    expect(body).toMatchObject({ code: "FEATURE_DISABLED" });
    expect(JSON.stringify(body)).not.toMatch(/search|org-flags|hrms|knowledge/i);
  });
});

describe("KbHrLinkFlagsService — changing", () => {
  it("turns link on, writes once, and audits the before and after in the same transaction", async () => {
    const { service, written, audit } = harness(ROW(false, false, false));

    await service.update(actor, { link: true });

    expect(written).toEqual([
      { orgId: "org-flags", hrmsKbLinkEnabled: true, hrmsKbSearchEnabled: false, hrmsKbAiEnabled: false },
    ]);
    expect(audit.logCritical).toHaveBeenCalledTimes(1);
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "kb.hr_link.setting_updated",
        userId: "admin-1",
        orgId: "org-flags",
        before: { link: false, search: false, ai: false },
        after: { link: true, search: false, ai: false },
      }),
    );
  });

  it("writes and audits nothing when the request changes nothing", async () => {
    const { service, insert, audit } = harness(ROW(true, false, false));

    await service.update(actor, { link: true });

    expect(insert).not.toHaveBeenCalled();
    expect(audit.logCritical).not.toHaveBeenCalled();
  });

  it("takes the dependants down with a switch: link off switches search and ai off", async () => {
    const { service, written } = harness(ROW(true, true, true));

    await service.update(actor, { link: false });

    expect(written[0]).toMatchObject({ hrmsKbLinkEnabled: false, hrmsKbSearchEnabled: false, hrmsKbAiEnabled: false });
  });

  it("takes ai down with search", async () => {
    const { service, written } = harness(ROW(true, true, true));

    await service.update(actor, { search: false });

    expect(written[0]).toMatchObject({ hrmsKbLinkEnabled: true, hrmsKbSearchEnabled: false, hrmsKbAiEnabled: false });
  });

  it("refuses search while linking is off, with a machine code", async () => {
    const { service, insert } = harness(ROW(false, false, false));

    const error = await service.update(actor, { search: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({ code: "HR_KB_FLAG_ORDER" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses ai while search is off", async () => {
    const { service } = harness(ROW(true, false, false));

    const error = await service.update(actor, { ai: true }).catch((e: unknown) => e);

    expect((error as HttpException).getResponse()).toMatchObject({ code: "HR_KB_FLAG_ORDER" });
  });

  it("accepts link and search in one request", async () => {
    const { service, written } = harness(ROW(false, false, false));

    await service.update(actor, { link: true, search: true });

    expect(written[0]).toMatchObject({ hrmsKbLinkEnabled: true, hrmsKbSearchEnabled: true });
  });

  it("refuses to turn anything on while the HR module is not enabled (409 HR_MODULE_NOT_ENABLED)", async () => {
    const { service, insert } = harness(ROW(false, false, false), false);

    const error = await service.update(actor, { link: true }).catch((e: unknown) => e);

    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({ code: "HR_MODULE_NOT_ENABLED" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("still lets an administrator turn things OFF while HR is not enabled", async () => {
    const { service, written } = harness(ROW(true, true, false), false);

    await service.update(actor, { link: false });

    expect(written[0]).toMatchObject({ hrmsKbLinkEnabled: false, hrmsKbSearchEnabled: false });
  });
});
