import { SetMetadata } from "@nestjs/common";

export const ALLOW_WITHOUT_MFA = "allow_without_mfa";

export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);
