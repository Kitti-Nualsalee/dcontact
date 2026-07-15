import { Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role: 'AGENT' | 'SUPERVISOR' | 'ADMIN';
  extension?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly select = {
    id: true,
    email: true,
    displayName: true,
    role: true,
    extension: true,
    isActive: true,
    createdAt: true,
  } as const;

  list(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId },
      select: this.select,
      orderBy: { createdAt: 'asc' },
    });
  }

  async get(tenantId: string, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: this.select,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async create(tenantId: string, input: CreateUserInput) {
    const passwordHash = await bcrypt.hash(input.password, 10);
    return this.prisma.user.create({
      data: {
        tenantId,
        email: input.email,
        passwordHash,
        displayName: input.displayName,
        role: input.role,
        extension: input.extension,
      },
      select: this.select,
    });
  }
}
