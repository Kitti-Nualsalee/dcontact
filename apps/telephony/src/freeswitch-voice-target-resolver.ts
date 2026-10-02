import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { FreeSwitchVoiceTargetResolver } from './freeswitch-command-adapter.js';

/** Sandbox resolver: อ่าน identity ภายใต้ tenant RLS และยอมให้ dial เฉพาะ internal extension. */
export class DatabaseFreeSwitchVoiceTargetResolver implements FreeSwitchVoiceTargetResolver {
  constructor(private readonly database: PrismaClient) {}

  async resolve(input: { tenantId: string; targetIdentityId: string }) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const identity = await transaction.contactIdentity.findFirst({
        where: { tenantId: input.tenantId, id: input.targetIdentityId, type: 'PHONE' },
        select: { value: true },
      });
      const extension = identity?.value.trim();
      return extension && /^1[0-9]{3}$/.test(extension) ? { extension } : null;
    });
  }
}
