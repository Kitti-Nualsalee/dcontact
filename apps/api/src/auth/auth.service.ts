import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';

export interface JwtPayload {
  sub: string; // user id
  tenantId: string;
  role: string;
  email: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(tenantSlug: string, email: string, password: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new UnauthorizedException('Invalid credentials');

    const user = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email } },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    return this.issueTokens({
      sub: user.id,
      tenantId: tenant.id,
      role: user.role,
      email: user.email,
    });
  }

  async refresh(refreshToken: string) {
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload & { typ: string }>(refreshToken);
      if (payload.typ !== 'refresh') throw new Error('not a refresh token');
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.isActive) throw new Error('user inactive');
      return this.issueTokens({
        sub: user.id,
        tenantId: user.tenantId,
        role: user.role,
        email: user.email,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async issueTokens(payload: JwtPayload) {
    const accessToken = await this.jwt.signAsync(
      { ...payload, typ: 'access' },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '15m' },
    );
    const refreshToken = await this.jwt.signAsync(
      { ...payload, typ: 'refresh' },
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d' },
    );
    return { accessToken, refreshToken };
  }
}
