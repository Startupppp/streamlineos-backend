import {
  userIntegrationConnections,
  type IntegrationConnectionStatus,
  type IntegrationToolkit,
} from "../../../db/schema";

export const CONNECTION_COLUMNS = {
  id: userIntegrationConnections.id,
  status: userIntegrationConnections.status,
  toolkit: userIntegrationConnections.toolkit,
  isPrimary: userIntegrationConnections.isPrimary,
  createdAt: userIntegrationConnections.createdAt,
  accountEmail: userIntegrationConnections.accountEmail,
  accountLabel: userIntegrationConnections.accountLabel,
} as const;

export type ConnectionRow = {
  id: number;
  status: IntegrationConnectionStatus;
  toolkit: IntegrationToolkit;
  isPrimary: boolean;
  createdAt: Date;
  accountEmail: string | null;
  accountLabel: string | null;
};
