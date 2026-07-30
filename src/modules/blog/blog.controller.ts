import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BlogService, isDuplicateCategory } from "./blog.service";
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  feedSchema,
  postCreateSchema,
  postUpdateSchema,
  type CategoryCreateInput,
  type CategoryUpdateInput,
  type FeedInput,
  type PostCreateInput,
  type PostUpdateInput,
} from "./dto/blog.schemas";

@Controller("blog")
@UseGuards(JwtAuthGuard)
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  @Public()
  @Get("by-slug/:slug")
  async getPostBySlug(@Param("slug") slug: string) {
    const post = await this.blog.getPublishedPostBySlug(slug);
    if (!post) throw new NotFoundException("Post not found");
    return post;
  }

  @Public()
  @Get("by-slug/:slug/adjacent")
  getAdjacentPosts(@Param("slug") slug: string) {
    return this.blog.getAdjacentPosts(slug);
  }

  @Public()
  @Get("categories")
  listCategories() {
    return this.blog.getCategories();
  }

  @Public()
  @Get("feed")
  feed(@Query(new ZodValidationPipe(feedSchema)) query: FeedInput) {
    return this.blog.getPublishedPosts(query);
  }
}
