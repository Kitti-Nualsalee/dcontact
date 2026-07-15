import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { QueuesController } from './queues.controller';
import { QueuesService } from './queues.service';

@Module({
  controllers: [QueuesController],
  providers: [QueuesService, PrismaService],
})
export class QueuesModule {}
