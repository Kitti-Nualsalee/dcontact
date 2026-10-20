import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { HttpException } from '@nestjs/common';

export type TenantPeopleRole = 'AGENT' | 'SUPERVISOR' | 'ADMIN';

export interface PeopleCreateCommand {
  commandId: string;
  displayName: string;
  email: string;
  username: string;
  role: TenantPeopleRole;
  teamId: string;
  extension: string | null;
}

function invalid(field: string): never {
  throw new HttpException({ code: 'VALIDATION_FAILED', field }, 400);
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    invalid(field);
  }
  return value.toLowerCase();
}

function emailAddress(value: unknown): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) invalid('email');
  const trimmed = value.trim();
  if (!/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(trimmed)) invalid('email');
  const separator = trimmed.lastIndexOf('@');
  const hostname = trimmed.slice(separator + 1).replace(/\.$/, '');
  if (/[/:@?#\s]/.test(hostname)) invalid('email');
  const domain = domainToASCII(hostname).toLowerCase();
  const labels = domain.split('.');
  if (
    !domain ||
    domain.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
  )
    invalid('email');
  const email = `${trimmed.slice(0, separator)}@${domain}`;
  if (email.length > 254) invalid('email');
  return email;
}

export function normalizePeopleCreate(value: unknown): PeopleCreateCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('body');
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const allowed = new Set(['commandId', 'displayName', 'email', 'role', 'teamId', 'extension']);
  if (Object.keys(fields).some((field) => !allowed.has(field))) invalid('body');
  if (typeof fields.displayName !== 'string' || /[\p{Cc}\p{Cf}]/u.test(fields.displayName)) {
    invalid('displayName');
  }
  const displayName = fields.displayName.trim().replace(/\s+/gu, ' ');
  if ([...displayName].length < 1 || [...displayName].length > 120) invalid('displayName');
  const role = fields.role;
  if (role !== 'AGENT' && role !== 'SUPERVISOR' && role !== 'ADMIN') invalid('role');
  const extension = fields.extension ?? null;
  if (role === 'AGENT') {
    if (typeof extension !== 'string' || !/^[0-9]{4,6}$/.test(extension)) invalid('extension');
  } else if (extension !== null) invalid('extension');
  const email = emailAddress(fields.email);
  return {
    commandId: uuid(fields.commandId, 'commandId'),
    displayName,
    email,
    username: email,
    role,
    teamId: uuid(fields.teamId, 'teamId'),
    extension,
  };
}

export function peopleCreateDigest(command: PeopleCreateCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action: 'CREATE_TENANT_USER',
        displayName: command.displayName,
        email: command.email,
        role: command.role,
        teamId: command.teamId,
        extension: command.extension,
      }),
    )
    .digest('hex');
}
