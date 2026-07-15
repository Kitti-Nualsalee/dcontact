import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { ChannelType } from '@d-contact/db';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/auth.service';
import { QueuesService } from './queues.service';

const CHANNELS = ['VOICE', 'WEBCHAT', 'LINE', 'FACEBOOK', 'WHATSAPP', 'EMAIL'] as const;

class CreateQueueDto {
  @IsString()
  name!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(CHANNELS, { each: true })
  channels!: ChannelType[];

  @IsOptional()
  @IsInt()
  @Min(1)
  slaThresholdSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxWaitSec?: number;

  @IsOptional()
  @IsInt()
  priority?: number;
}

@Controller('queues')
@UseGuards(JwtAuthGuard)
export class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.queues.list(user.tenantId);
  }

  @Get(':id')
  get(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.queues.get(user.tenantId, id);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateQueueDto) {
    return this.queues.create(user.tenantId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Partial<CreateQueueDto>,
  ) {
    return this.queues.update(user.tenantId, id, dto);
  }
}
