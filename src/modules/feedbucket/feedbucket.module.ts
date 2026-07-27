import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { FeedbucketController } from "./feedbucket.controller";
import { FeedbucketPublicController } from "./feedbucket-public.controller";
import { FeedbucketWidgetsService } from "./feedbucket-widgets.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";
import { FeedbucketPublicService } from "./feedbucket-public.service";
import { FeedbucketAiService } from "./feedbucket-ai.service";
import { FeedbucketCorsMiddleware } from "./feedbucket-cors.middleware";
import { ProjectsModule } from "../build/projects.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AiModule } from "../ai/ai.module";
import { BillingModule } from "../billing/billing.module";

@Module({
  imports: [ProjectsModule, NotificationsModule, AiModule, BillingModule],
  controllers: [FeedbucketController, FeedbucketPublicController],
  providers: [
    FeedbucketWidgetsService,
    FeedbucketSubmissionsService,
    FeedbucketPublicService,
    FeedbucketAiService,
    FeedbucketCorsMiddleware,
  ],
})
export class FeedbucketModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(FeedbucketCorsMiddleware)
      .forRoutes({ path: "public/feedbucket/*", method: RequestMethod.ALL });
  }
}
