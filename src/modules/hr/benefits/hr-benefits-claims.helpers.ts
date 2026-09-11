import { BadRequestException } from "@nestjs/common";
import { decodeCursor } from "../../../common/pagination/cursor";

export type ClaimsCursorScope = {
  orgId: string;
  requesterMembershipId: number | null;
  isAdmin: boolean;
  status: string | null;
  userId: string | null;
};

export function invalidClaimsCursor(): never {
  throw new BadRequestException({
    code: "INVALID_BENEFITS_CLAIMS_CURSOR",
    message: "The benefits claims cursor is invalid or expired.",
  });
}

export function decodeClaimsCursor(value: string | undefined, expected: ClaimsCursorScope) {
  if (!value) return null;
  const position = decodeCursor(value);
  if (!position || Number.isNaN(new Date(position.sortValue).getTime()))
    return invalidClaimsCursor();

  try {
    const scope: unknown = JSON.parse(position.id);
    if (
      !Array.isArray(scope) ||
      scope.length !== 6 ||
      typeof scope[0] !== "number" ||
      !Number.isSafeInteger(scope[0]) ||
      scope[0] < 1 ||
      scope[1] !== expected.orgId ||
      scope[2] !== expected.requesterMembershipId ||
      scope[3] !== expected.isAdmin ||
      scope[4] !== expected.status ||
      scope[5] !== expected.userId
    )
      return invalidClaimsCursor();
    return { sortValue: position.sortValue, id: String(scope[0]) };
  } catch {
    return invalidClaimsCursor();
  }
}
