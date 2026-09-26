import { SetMetadata } from "@nestjs/common";

export const IS_PORTAL_ROUTE = "isPortalRoute";

export const PortalRoute = () => SetMetadata(IS_PORTAL_ROUTE, true);
