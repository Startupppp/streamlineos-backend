import { ForbiddenException } from "@nestjs/common";

export function moduleAccessDenied(action: "view" | "manage"): ForbiddenException {
  return new ForbiddenException(
    `You do not have permission to ${action} this module's access settings`,
  );
}

export function moduleOwnershipTransferDenied(): ForbiddenException {
  return new ForbiddenException(
    "Only the module owner or an organization owner can transfer module ownership",
  );
}
