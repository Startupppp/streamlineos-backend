import { Injectable } from "@nestjs/common";
import type { DataScope } from "../../access/access.types";
import type {
  CreateProductInput,
  UpdateProductInput,
  ListProductsInput,
  CreateVariantInput,
  UpdateVariantInput,
  CreateCategoryInput,
  CreateUomInput,
  UpdateCategoryInput,
  UpdateUomInput,
  ListVariantsInput,
} from "./dto/inv-products.schemas";
import { InvProductCrudService } from "./inv-product-crud.service";
import { InvProductCatalogService } from "./inv-product-catalog.service";

@Injectable()
export class InvProductsService {
  constructor(
    private readonly crud: InvProductCrudService,
    private readonly catalog: InvProductCatalogService,
  ) {}

  listProducts(
    orgId: string,
    filters: ListProductsInput,
    scope: DataScope = "all",
    userId?: string,
  ) {
    return this.crud.listProducts(orgId, filters, scope, userId);
  }

  getProduct(orgId: string, productId: number, userId?: string) {
    return this.crud.getProduct(orgId, productId, userId);
  }

  createProduct(orgId: string, userId: string, data: CreateProductInput) {
    return this.crud.createProduct(orgId, userId, data);
  }

  updateProduct(orgId: string, productId: number, data: UpdateProductInput) {
    return this.crud.updateProduct(orgId, productId, data);
  }

  deleteProduct(orgId: string, productId: number) {
    return this.crud.deleteProduct(orgId, productId);
  }

  archiveProduct(orgId: string, productId: number, userId: string) {
    return this.crud.archiveProduct(orgId, productId, userId);
  }

  restoreProduct(orgId: string, productId: number, userId: string) {
    return this.crud.restoreProduct(orgId, productId, userId);
  }

  createVariant(orgId: string, productId: number, data: CreateVariantInput) {
    return this.catalog.createVariant(orgId, productId, data);
  }

  updateVariant(orgId: string, variantId: number, data: UpdateVariantInput) {
    return this.catalog.updateVariant(orgId, variantId, data);
  }

  listVariants(orgId: string, filters: ListVariantsInput) {
    return this.catalog.listVariants(orgId, filters);
  }

  listCategories(orgId: string) {
    return this.catalog.listCategories(orgId);
  }

  createCategory(orgId: string, data: CreateCategoryInput) {
    return this.catalog.createCategory(orgId, data);
  }

  updateCategory(orgId: string, categoryId: number, data: UpdateCategoryInput) {
    return this.catalog.updateCategory(orgId, categoryId, data);
  }

  listUom(orgId: string) {
    return this.catalog.listUom(orgId);
  }

  createUom(orgId: string, data: CreateUomInput) {
    return this.catalog.createUom(orgId, data);
  }

  updateUom(orgId: string, uomId: number, data: UpdateUomInput) {
    return this.catalog.updateUom(orgId, uomId, data);
  }
}
