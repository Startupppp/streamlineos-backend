import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrInterviewBookingService } from "./hr-interview-booking.service";
import { bookInterviewSchema, type BookInterviewInput } from "./dto/interview-scheduling.schemas";

@Public()
@Controller("public/interview-booking")
export class HrInterviewBookingController {
  constructor(private readonly booking: HrInterviewBookingService) {}

  @Post(":token")
  @HttpCode(200)
  book(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(bookInterviewSchema)) body: BookInterviewInput,
  ) {
    return this.booking.book(token, body);
  }
}
