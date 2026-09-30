import { Module } from "@nestjs/common";
import { BlogController } from "./blog.controller";
import { BlogInternalController } from "./blog-internal.controller";
import { BlogService } from "./blog.service";
import { BlogCategoriesService } from "./blog-categories.service";
import { BlogDiscoveryService } from "./blog-discovery.service";
import { BlogInvalidationService } from "./blog-invalidation.service";

@Module({
  controllers: [BlogController, BlogInternalController],
  providers: [BlogService, BlogCategoriesService, BlogDiscoveryService, BlogInvalidationService],
})
export class BlogModule {}
