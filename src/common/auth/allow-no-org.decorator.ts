import { SetMetadata } from "@nestjs/common";

export const ALLOW_NO_ORG_KEY = "allowNoOrg";
export const AllowNoOrg = () => SetMetadata(ALLOW_NO_ORG_KEY, true);
