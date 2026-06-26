import { dispatchEmail, getEmailProvider, type EmailOptions, type Provider } from "./email.provider";

export abstract class EmailBase {
  sendEmail(options: EmailOptions): Promise<void> {
    return dispatchEmail(options);
  }

  getEmailProvider(): Provider {
    return getEmailProvider();
  }
}
