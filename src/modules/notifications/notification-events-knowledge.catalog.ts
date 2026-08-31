import {
  IN_APP,
  IN_APP_EMAIL,
  KNOWLEDGE_PAGE_RESOURCE,
} from "./notification-event-channel-policy";
import { notificationEvent } from "./notification-event-factory";

const e = notificationEvent;
const IA = IN_APP;
const IA_EMAIL = IN_APP_EMAIL;
const KB_PAGE = KNOWLEDGE_PAGE_RESOURCE;

export const KNOWLEDGE_NOTIFICATION_EVENTS = [
  e(
    "knowledge.article.mentioned",
    "knowledge",
    "KNOWLEDGE",
    "Mentioned in an article",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      dedupeWindowSeconds: 0,
    },
  ),
  e(
    "knowledge.article.comment_created",
    "knowledge",
    "KNOWLEDGE",
    "New article comment",
    { defaultChannels: IA },
  ),
  e(
    "knowledge.article.approval_requested",
    "knowledge",
    "WORKFLOW",
    "Article approval requested",
    { defaultPriority: "HIGH", defaultChannels: IA_EMAIL },
  ),
  e(
    "knowledge.article.published",
    "knowledge",
    "KNOWLEDGE",
    "Article published",
    { defaultPriority: "LOW", defaultChannels: IA },
  ),
  e("knowledge.ai.answer_ready", "knowledge", "AI", "AI answer ready", {
    defaultChannels: IA,
  }),
  e(
    "knowledge.document.ingestion_failed",
    "knowledge",
    "KNOWLEDGE",
    "Document ingestion failed",
    {
      defaultPriority: "HIGH",
      defaultType: "ERROR",
      defaultChannels: IA_EMAIL,
    },
  ),
  e(
    "knowledge.page.comment_created",
    "knowledge",
    "KNOWLEDGE",
    "New comment on your page",
    { defaultChannels: IA, visibilityResourceKind: KB_PAGE },
  ),
  e(
    "knowledge.page.review_requested",
    "knowledge",
    "WORKFLOW",
    "Page review requested",
    {
      defaultPriority: "HIGH",
      defaultChannels: IA_EMAIL,
      visibilityResourceKind: KB_PAGE,
    },
  ),
  e(
    "knowledge.page.review_approved",
    "knowledge",
    "KNOWLEDGE",
    "Page review approved",
    {
      defaultType: "SUCCESS",
      defaultChannels: IA,
      visibilityResourceKind: KB_PAGE,
    },
  ),
  e(
    "knowledge.page.review_rejected",
    "knowledge",
    "KNOWLEDGE",
    "Page review rejected",
    {
      defaultType: "WARNING",
      defaultChannels: IA,
      visibilityResourceKind: KB_PAGE,
    },
  ),
  e("sign.document.sent", "sign", "SIGN", "Document sent for signature", {
    defaultChannels: IA_EMAIL,
  }),
  e("sign.document.viewed", "sign", "SIGN", "Document viewed", {
    defaultPriority: "LOW",
    defaultChannels: IA,
  }),
  e("sign.document.signed", "sign", "SIGN", "Document signed", {
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
  }),
  e("sign.document.completed", "sign", "SIGN", "Document completed", {
    defaultPriority: "HIGH",
    defaultType: "SUCCESS",
    defaultChannels: IA_EMAIL,
    mandatory: true,
    userConfigurable: false,
    quietHoursBehavior: "bypass_if_high",
  }),
  e("sign.document.expiring", "sign", "SIGN", "Document expiring", {
    defaultPriority: "HIGH",
    defaultChannels: IA_EMAIL,
  }),
  e("sign.document.declined", "sign", "SIGN", "Document declined", {
    defaultPriority: "HIGH",
    defaultType: "WARNING",
    defaultChannels: IA_EMAIL,
  }),
];
