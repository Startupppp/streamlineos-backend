import {
  notificationListResponseSchema,
  notificationCountResponseSchema,
} from "../../modules/notifications/dto/notification-response-schema";

export { notificationListResponseSchema as inboxListResponseSchema };
export { notificationCountResponseSchema as inboxCountResponseSchema };
export {
  unifiedInboxResponseSchema,
  unifiedCountResponseSchema,
} from "../../modules/notifications/dto/unified-inbox.schemas";
