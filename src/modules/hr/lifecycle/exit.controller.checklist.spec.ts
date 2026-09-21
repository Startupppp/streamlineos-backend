import "reflect-metadata";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { ExitController } from "./exit.controller";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-exit-checklist";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(10, false),
    ...overrides,
  };
}

function buildController(held: string[], checklist: { updateItem: jest.Mock }) {
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map(held.map((key) => [key, "all"]))) };
  return new ExitController(
    undefined as never,
    undefined as never,
    checklist as never,
    undefined as never,
    access as never,
    undefined as never,
    undefined as never,
  );
}

describe("PATCH /hr/exit/:resignationId/checklist/:itemKey", () => {
  const handler = ExitController.prototype.updateChecklistItem;

  it("is a permission-gated, replay-safe PATCH on the exit route family", () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(":resignationId/checklist/:itemKey");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PATCH);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe("hr:exit:view");
    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, handler)).toBe("hr.exit.checklist.update");
  });

  it("passes an exit administrator through as such, so any item is theirs to update", async () => {
    const checklist = { updateItem: jest.fn().mockResolvedValue({ itemKey: "asset_return" }) };
    const controller = buildController(["hr:exit:manage"], checklist);

    await controller.updateChecklistItem(7, "asset_return", { status: "DONE", evidence: "Returned" }, makeUser());

    expect(checklist.updateItem).toHaveBeenCalledWith(
      ORG_ID,
      { userId: "user-1", membershipId: 10, isAdmin: true },
      7,
      "asset_return",
      { status: "DONE", evidence: "Returned" },
    );
  });

  it("passes an ordinary viewer through as a non-admin, so ownership decides the answer", async () => {
    const checklist = { updateItem: jest.fn().mockRejectedValue(new ForbiddenException("Only the item's owner or an exit administrator can update it.")) };
    const controller = buildController(["hr:exit:view"], checklist);

    await expect(controller.updateChecklistItem(7, "asset_return", { notes: "n" }, makeUser())).rejects.toBeInstanceOf(ForbiddenException);
    expect(checklist.updateItem).toHaveBeenCalledWith(ORG_ID, { userId: "user-1", membershipId: 10, isAdmin: false }, 7, "asset_return", { notes: "n" });
  });

  it("surfaces a cross-tenant miss as 404 rather than 403", async () => {
    const checklist = { updateItem: jest.fn().mockRejectedValue(new NotFoundException("Resignation not found.")) };
    const controller = buildController(["hr:exit:manage"], checklist);

    await expect(controller.updateChecklistItem(7, "asset_return", { notes: "n" }, makeUser())).rejects.toBeInstanceOf(NotFoundException);
  });
});
