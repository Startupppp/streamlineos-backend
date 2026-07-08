import type {
  NotificationChannel,
  ProviderSendInput,
  ProviderSendResult,
  ProviderValidationResult,
} from "../notification.types";

export interface NotificationChannelProvider {
  readonly channel: NotificationChannel;
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
  validateConfig(config: unknown): Promise<ProviderValidationResult>;
  sendTest(input: ProviderSendInput): Promise<ProviderSendResult>;
}
