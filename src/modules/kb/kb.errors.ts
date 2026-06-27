import { HttpException, HttpStatus } from "@nestjs/common";

export class InsufficientCreditsException extends HttpException {
  constructor() {
    super(
      { error: "Insufficient AI credits", code: "INSUFFICIENT_CREDITS" },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
