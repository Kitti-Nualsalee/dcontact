import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      name: 'Demo Company',
      slug: 'demo',
      sipDomain: 'dcontact.local', // ตรงกับ vars.xml ของ FreeSWITCH dev
    },
  });

  const passwordHash = await bcrypt.hash('admin1234', 10);

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'admin@demo.local' } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'admin@demo.local',
      passwordHash,
      displayName: 'Demo Admin',
      role: 'ADMIN',
    },
  });

  const agentHash = await bcrypt.hash('agent1234', 10);
  for (const ext of ['1000', '1001']) {
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: `agent${ext}@demo.local` } },
      update: {},
      create: {
        tenantId: tenant.id,
        email: `agent${ext}@demo.local`,
        passwordHash: agentHash,
        displayName: `Agent ${ext}`,
        role: 'AGENT',
        extension: ext,
        sipPassword: 'DContactDev1', // ตรงกับ default_password ใน FreeSWITCH dev directory
      },
    });
  }

  const skill = await prisma.skill.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'general' } },
    update: {},
    create: { tenantId: tenant.id, name: 'general' },
  });

  const queue = await prisma.queue.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'General Support' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'General Support',
      channels: ['VOICE', 'WEBCHAT', 'LINE', 'FACEBOOK', 'WHATSAPP', 'EMAIL'],
      slaThresholdSec: 20,
    },
  });

  await prisma.queueSkill.upsert({
    where: { queueId_skillId: { queueId: queue.id, skillId: skill.id } },
    update: {},
    create: { queueId: queue.id, skillId: skill.id, minLevel: 1 },
  });

  const agents = await prisma.user.findMany({
    where: { tenantId: tenant.id, role: 'AGENT' },
  });
  for (const agent of agents) {
    await prisma.agentSkill.upsert({
      where: { userId_skillId: { userId: agent.id, skillId: skill.id } },
      update: {},
      create: { userId: agent.id, skillId: skill.id, level: 3 },
    });
  }

  console.log(`Seeded tenant "${tenant.slug}" (${tenant.id})`);
  console.log('  admin@demo.local / admin1234');
  console.log('  agent1000@demo.local, agent1001@demo.local / agent1234 (SIP ext 1000, 1001)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
