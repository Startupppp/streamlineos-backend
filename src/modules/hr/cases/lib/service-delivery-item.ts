import type { AgingResult } from "./service-delivery-aging";

export type ServiceDeliveryKind = "case" | "safety_incident" | "helpdesk";

export interface ServiceDeliveryItem {
  kind: ServiceDeliveryKind;
  id: number;
  ref: string;
  title: string;
  status: string;
  severity: string | null;
  assignedTo: string | null;
  href: string;
  createdAt: string;
  aging: AgingResult;
  severityRank: number;
  confidential?: boolean;
}
