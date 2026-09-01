import { Module } from "@nestjs/common";
import { BlogController } from "./blog.controller";
import { BlogAdminController } from "./blog-admin.controller";
import { BlogService } from "./blog.service";

@Module({ controllers: [BlogController, BlogAdminController], providers: [BlogService] })
export class BlogModule {}
