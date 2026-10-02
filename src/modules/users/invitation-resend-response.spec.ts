import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { InvitationLifecycleService } from "../organization/core/invitation-lifecycle.service";
import { invitationResendResponseSchema } from "./dto/users-response.schemas";
import { UsersController } from "./users.controller";

function controllerWith(resend: jest.Mock): UsersController {
  return new UsersController(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { resend } as unknown as InvitationLifecycleService,
    undefined as never,
  );
}

const actor = {
  orgId: "org-1",
  userId: "owner-1",
  isOrgOwner: true,
} as CurrentUserContext;

describe("POST /users/invitations/:invitationId/resend response", () => {
  it.each([
    { deliveryQueued: true, deliveryFailureReason: null },
    {
      deliveryQueued: false,
      deliveryFailureReason: "No email provider is configured, so the email could not be sent.",
    },
    {
      deliveryQueued: false,
      deliveryFailureReason:
        "The address is on the email suppression list after a bounce or unsubscribe, so no email was sent.",
    },
  ])("returns the durable queue outcome without exposing the raw token", async (outcome) => {
    const resend = jest.fn().mockResolvedValue({
      success: true,
      rawToken: "must-not-leave-service",
      email: "invitee@example.com",
      expiresAt: new Date(),
      ...outcome,
    });
    const controller = controllerWith(resend);

    const response = await controller.resendInvite("inv-1", actor);

    expect(response).toEqual({ success: true, ...outcome });
    expect(response).not.toHaveProperty("rawToken");
    expect(invitationResendResponseSchema.safeParse(response).success).toBe(true);
    expect(resend).toHaveBeenCalledWith("org-1", "inv-1", {
      userId: "owner-1",
      isOrgOwner: true,
    });
  });

  it("rejects the former success-only response as incomplete", () => {
    expect(invitationResendResponseSchema.safeParse({ success: true }).success).toBe(false);
  });
});
