import { Catch, HttpException, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common';
@Catch()
export class VoiceCatalogErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest();
    const response = host.switchToHttp().getResponse();
    let status = 500,
      body: Record<string, unknown> = { code: 'INTERNAL_ERROR' };
    if (error instanceof HttpException) {
      status = error.getStatus();
      const value = error.getResponse();
      body = typeof value === 'string' ? { message: value } : (value as Record<string, unknown>);
    } else if (error instanceof Error && error.message.includes('VOICE_CONFIG_V1_REQUIRED')) {
      status = 409;
      body = { code: 'VOICE_CONFIG_V1_REQUIRED' };
    }
    response.status(status).json({ ...body, correlationId: request.correlationId });
  }
}
