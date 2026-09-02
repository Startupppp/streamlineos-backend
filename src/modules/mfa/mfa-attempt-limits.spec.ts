import { HttpException, HttpStatus } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { MfaController } from "./mfa.controller";
import type { MfaService } from "./mfa.service";

const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function makeController(allowed: boolean) {
  const mfa = {
    verify: jest.fn().mockResolvedValue({ enabled: true }),
    disable: jest.fn().mockResolvedValue({ disabled: true }),
    reset: jest.fn().mockResolvedValue({ reset: true }),
  } as unknown as MfaService;
  const check = jest
    .fn()
    .mockResolvedValue({ allowed, retryAfterSecs: allowed ? 0 : 120 });
  const rateLimit = { check } as unknown as RateLimitService;
  return { controller: new MfaController(mfa, rateLimit), mfa, check };
}

describe("MfaController attempt limits", () => {
  it("counts a verify attempt against the caller, not their address", async () => {
    const { controller, mfa, check } = makeController(true);

    await controller.verify({ token: "123456" }, actor);

    expect(check).toHaveBeenCalledWith("auth:mfa-verify", actor.userId);
    expect(mfa.verify).toHaveBeenCalledWith(actor.userId, { token: "123456" });
  });

  it("refuses a verify attempt once the limit is exhausted, without reaching the service", async () => {
    const { controller, mfa } = makeController(false);

    await expect(controller.verify({ token: "123456" }, actor)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    await expect(
      controller.verify({ token: "123456" }, actor),
    ).rejects.toBeInstanceOf(HttpException);
    expect(mfa.verify).not.toHaveBeenCalled();
  });

  it("refuses a disable attempt once the limit is exhausted", async () => {
    const { controller, mfa } = makeController(false);

    await expect(controller.disable({ token: "123456" }, actor)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(mfa.disable).not.toHaveBeenCalled();
  });

  it("resets another member's MFA only within the caller's own organization", async () => {
    const { controller, mfa } = makeController(true);

    await controller.reset({ userId: "user-2" }, actor);

    expect(mfa.reset).toHaveBeenCalledWith("user-2", actor.orgId);
  });
});
