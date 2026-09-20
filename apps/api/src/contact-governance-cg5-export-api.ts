import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PrismaClient } from '@d-contact/db';
import {
  Cg4DatabaseAuthorizationPort,
  Cg5ExportIdempotencyConflictError,
  Cg5ExportJobRepository,
  Cg5ExportLifecycleService,
  Cg5ExportRangeTooLargeError,
  Cg5ExportRateLimitError,
  PrismaCg5TenantConfigRepository,
  cg4RefDigest,
  resolveCg4EvidenceAccess,
  type Cg5ExportObjectStorage,
} from '@d-contact/contact-governance';
import { CG5_EXPORT_DATASETS, type Cg5ExportDataset } from '@d-contact/cxa-contracts';
import { CONTACT_GOVERNANCE_DATABASE } from './contact-governance-api.js';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const CG5_EXPORT_STORAGE = Symbol('CG5_EXPORT_STORAGE');

export interface Cg5ExportDownloadStorage extends Cg5ExportObjectStorage {
  presignDownload(
    tenantId: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<{ url: string; expiresAt: Date }>;
}

const DATASETS = new Set<string>(CG5_EXPORT_DATASETS);

function identity(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return request.gatewayIdentity;
}

function uuid(value: string, field: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `${field} ต้องเป็น UUID` });
  }
  return value;
}

function date(value: unknown, field: string): Date {
  if (typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${field} ต้องเป็น ISO date`,
    });
  }
  return parsed;
}

function requestBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'body ต้องเป็น object' });
  }
  return value as Record<string, unknown>;
}

function datasets(value: unknown): Cg5ExportDataset[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || !DATASETS.has(item))
  ) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'datasets ไม่ถูกต้อง' });
  }
  if (new Set(value).size !== value.length) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'datasets ต้องไม่ซ้ำ' });
  }
  return value as Cg5ExportDataset[];
}

function reason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'reason ต้องมีความยาว 1-500 ตัวอักษร',
    });
  }
  return value.trim();
}

function idempotencyKey(request: AuthenticatedGatewayRequest): string {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.trim()) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'header Idempotency-Key ต้องระบุ',
    });
  }
  return value.trim();
}

function presentation(
  job: {
    exportId: string;
    datasets: string[];
    rangeFrom: Date;
    rangeTo: Date;
    filters: unknown;
    evidenceLevel: string;
    state: string;
    manifestDigest: string | null;
    rowCounts: unknown;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    requestedByRef: string;
  },
  level: 'SUMMARY' | 'EVIDENCE',
) {
  return {
    exportId: job.exportId,
    datasets: job.datasets,
    rangeFrom: job.rangeFrom.toISOString(),
    rangeTo: job.rangeTo.toISOString(),
    filters: job.filters,
    evidenceLevel: job.evidenceLevel,
    state: job.state,
    manifestDigest: job.manifestDigest,
    rowCounts: job.rowCounts,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    requestedByRef:
      level === 'EVIDENCE' ? job.requestedByRef : `redacted:${cg4RefDigest(job.requestedByRef)}`,
  };
}

@Controller('api/v1/contact-governance/exports')
export class ContactGovernanceCg5ExportController {
  private readonly jobs: Cg5ExportJobRepository;
  private readonly config: PrismaCg5TenantConfigRepository;
  private readonly authorization: Cg4DatabaseAuthorizationPort;
  private readonly lifecycle: Cg5ExportLifecycleService;

  constructor(
    @Inject(CONTACT_GOVERNANCE_DATABASE) private readonly database: PrismaClient,
    @Inject(CG5_EXPORT_STORAGE) private readonly storage: Cg5ExportDownloadStorage,
  ) {
    this.jobs = new Cg5ExportJobRepository(database);
    this.config = new PrismaCg5TenantConfigRepository(database);
    this.authorization = new Cg4DatabaseAuthorizationPort(database);
    this.lifecycle = new Cg5ExportLifecycleService(database, storage);
  }

  @Post()
  @GatewayRoles('admin', 'compliance')
  async create(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const actor = await this.actor(request);
    const input = requestBody(body);
    const evidenceLevel = input.evidenceLevel === 'EVIDENCE' ? 'EVIDENCE' : 'SUMMARY';
    if (input.evidenceLevel !== undefined && evidenceLevel !== input.evidenceLevel) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'evidenceLevel ไม่ถูกต้อง',
      });
    }
    if (evidenceLevel === 'EVIDENCE' && actor.level !== 'EVIDENCE') {
      throw new ForbiddenException({ code: 'CAPABILITY_REQUIRED' });
    }
    const rangeFrom = date(input.rangeFrom, 'rangeFrom');
    const rangeTo = date(input.rangeTo, 'rangeTo');
    if (rangeFrom >= rangeTo)
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'range ไม่ถูกต้อง' });
    const filters = input.filters ?? {};
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'filters ต้องเป็น object',
      });
    }
    try {
      const config = await this.config.read(actor.tenantId);
      const job = await this.jobs.request({
        tenantId: actor.tenantId,
        datasets: datasets(input.datasets),
        rangeFrom,
        rangeTo,
        filters: filters as Record<string, unknown>,
        evidenceLevel,
        reason: reason(input.reason),
        requestedByRef: `workspace:${actor.userId}`,
        idempotencyKey: idempotencyKey(request),
        limits: {
          maxRangeDays: config.config.exportMaxRangeDays,
          maxPerDay: config.config.exportMaxPerDay,
        },
      });
      return presentation(job, actor.level);
    } catch (error) {
      this.map(error);
    }
  }

  @Get()
  @GatewayRoles('admin', 'compliance')
  async list(@Req() request: AuthenticatedGatewayRequest) {
    const actor = await this.actor(request);
    const jobs = await this.jobs.list(actor.tenantId);
    return { items: jobs.map((job) => presentation(job, actor.level)) };
  }

  @Get(':exportId')
  @GatewayRoles('admin', 'compliance')
  async get(@Req() request: AuthenticatedGatewayRequest, @Param('exportId') exportId: string) {
    const actor = await this.actor(request);
    const job = await this.jobs.get(actor.tenantId, uuid(exportId, 'exportId'));
    if (!job) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return presentation(job, actor.level);
  }

  @Get(':exportId/download')
  @GatewayRoles('admin', 'compliance')
  async download(@Req() request: AuthenticatedGatewayRequest, @Param('exportId') exportId: string) {
    const actor = await this.actor(request);
    const id = uuid(exportId, 'exportId');
    const job = await this.jobs.get(actor.tenantId, id);
    if (job?.state === 'READY' && job.expiresAt && job.expiresAt <= new Date()) {
      await this.lifecycle.expireDue(actor.tenantId);
    }
    if (
      !job ||
      job.state !== 'READY' ||
      !job.storagePrefix ||
      !job.expiresAt ||
      job.expiresAt <= new Date()
    ) {
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    }
    if (job.evidenceLevel === 'EVIDENCE' && actor.level !== 'EVIDENCE') {
      throw new ForbiddenException({ code: 'CAPABILITY_REQUIRED' });
    }
    const signed = await this.storage.presignDownload(
      actor.tenantId,
      `${job.storagePrefix}/manifest.json`,
      300,
    );
    const recorded = await this.jobs.recordDownload({
      tenantId: actor.tenantId,
      exportId: id,
      actorRef: `workspace:${actor.userId}`,
    });
    if (!recorded) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      manifestDigest: job.manifestDigest,
    };
  }

  private async actor(request: AuthenticatedGatewayRequest) {
    const actor = identity(request);
    try {
      const subject = await this.authorization.resolveSubject({
        tenantId: actor.tenantId as never,
        subjectId: actor.userId as never,
      });
      if (!subject) throw new ForbiddenException({ code: 'CAPABILITY_REQUIRED' });
      return { ...actor, level: resolveCg4EvidenceAccess({ capabilities: subject.capabilities }) };
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ServiceUnavailableException({ code: 'AUTHORIZATION_CONTEXT_UNAVAILABLE' });
    }
  }

  private map(error: unknown): never {
    if (error instanceof Cg5ExportIdempotencyConflictError) {
      throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    if (error instanceof Cg5ExportRangeTooLargeError) {
      throw new BadRequestException({
        code: 'CG5_EXPORT_RANGE_TOO_LARGE',
        maxRangeDays: error.maxRangeDays,
      });
    }
    if (error instanceof Cg5ExportRateLimitError) {
      throw new HttpException(
        { code: 'CG5_EXPORT_RATE_LIMIT', maxPerDay: error.maxPerDay },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (error instanceof BadRequestException || error instanceof ForbiddenException) throw error;
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: error.message });
    }
    throw error;
  }
}
