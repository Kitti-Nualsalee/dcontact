import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@d-contact/db';

/**
 * หมายเหตุ tenant isolation:
 * ทุก query ใน service layer ต้อง scope ด้วย tenantId จาก JWT เสมอ (ห้ามรับจาก client)
 * RLS ที่ DB (prisma/rls.sql) เป็น defense-in-depth ชั้นที่สอง
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
