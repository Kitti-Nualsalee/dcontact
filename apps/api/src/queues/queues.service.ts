import { Injectable, NotFoundException } from '@nestjs/common';
import type { ChannelType } from '@d-contact/db';
import { PrismaService } from '../prisma.service';

export interface UpsertQueueInput {
  name: string;
  channels: ChannelType[];
  slaThresholdSec?: number;
  maxWaitSec?: number;
  priority?: number;
}

@Injectable()
export class QueuesService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string) {
    return this.prisma.queue.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async get(tenantId: string, id: string) {
    const queue = await this.prisma.queue.findFirst({ where: { id, tenantId } });
    if (!queue) throw new NotFoundException('Queue not found');
    return queue;
  }

  create(tenantId: string, input: UpsertQueueInput) {
    return this.prisma.queue.create({ data: { tenantId, ...input } });
  }

  async update(tenantId: string, id: string, input: Partial<UpsertQueueInput>) {
    await this.get(tenantId, id); // ตรวจ ownership ก่อน
    return this.prisma.queue.update({ where: { id }, data: input });
  }
}
