import { Module } from "@nestjs/common";
import { CrmPricebooksController } from "./crm-pricebooks.controller";
import { CrmPricebooksService } from "./crm-pricebooks.service";

@Module({ controllers: [CrmPricebooksController], providers: [CrmPricebooksService] })
export class CrmPricebooksModule {}
