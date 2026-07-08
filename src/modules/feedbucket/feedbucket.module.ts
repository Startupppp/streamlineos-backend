import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { FeedbucketController } from "./feedbucket.controller";
import { FeedbucketPublicController } from "./feedbucket-public.controller";
import { FeedbucketWidgetsService } from "./feedbucket-widgets.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";
import { FeedbucketPublicService } from "./feedbucket-public.service";
import { FeedbucketCorsMiddleware } from "./feedbucket-cors.middleware";
import { ProjectsModule } from "../projects/projects.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [ProjectsModule, NotificationsModule],
  controllers: [FeedbucketController, FeedbucketPublicController],
  providers: [
    FeedbucketWidgetsService,
    FeedbucketSubmissionsService,
    FeedbucketPublicService,
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
