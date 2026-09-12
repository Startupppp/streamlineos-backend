import { Module } from "@nestjs/common";
import { BlogController } from "./blog.controller";
import { BlogAdminController } from "./blog-admin.controller";
import { BlogService } from "./blog.service";
import { BlogCategoriesService } from "./blog-categories.service";

@Module({ controllers: [BlogController, BlogAdminController], providers: [BlogService, BlogCategoriesService] })
export class BlogModule {}
