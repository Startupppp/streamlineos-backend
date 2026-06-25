import { SetMetadata } from "@nestjs/common";

export type AbilityVerb =
  | "create" | "read" | "update" | "delete" | "manage" | "approve" | "generate" | "view";

export type AbilitySubject = string;

export const CHECK_ABILITY = "check_ability";
export interface RequiredAbility {
  verb: AbilityVerb;
  subject: AbilitySubject;
}

export const CheckAbility = (verb: AbilityVerb, subject: AbilitySubject) =>
  SetMetadata(CHECK_ABILITY, { verb, subject } satisfies RequiredAbility);
