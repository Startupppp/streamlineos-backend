import type { Logger } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import type { NotificationsService } from "../notifications/notifications.service";

/**
 * What `AutonomyHoldService` hands its libs in place of `this`.
 *
 * `db` is the request transaction, the same handle the class holds, so every
 * write a lib makes lands in the transaction it landed in as a method. `logger`
 * keeps the `AutonomyHold` context on every line the libs write.
 */
export interface HoldDeps {
  readonly db: Db;
  readonly notifications: NotificationsService;
  readonly logger: Logger;
}
