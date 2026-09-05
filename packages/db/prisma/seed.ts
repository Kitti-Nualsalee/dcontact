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
    update: {
      recordingEnabled: true,
      recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
      recordingAnnouncementLanguage: 'th-TH',
      recordingPauseResumeEnabled: true,
      recordingAgentSelfAccess: true,
      recordingDownloadAllowed: false,
      recordingRetentionDays: 30,
      recordingChannelLayout: 'STEREO',
      transcriptionMode: 'AUTOMATIC',
      transcriptionLanguage: 'th-TH',
      transcriptionMaxAttempts: 3,
      autoQmEnabled: true,
    },
    create: {
      tenantId: tenant.id,
      name: 'General Support',
      channels: ['VOICE', 'WEBCHAT', 'LINE', 'FACEBOOK', 'WHATSAPP', 'EMAIL'],
      slaThresholdSec: 20,
      recordingEnabled: true,
      recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
      recordingAnnouncementLanguage: 'th-TH',
      recordingPauseResumeEnabled: true,
      recordingAgentSelfAccess: true,
      recordingDownloadAllowed: false,
      recordingRetentionDays: 30,
      recordingChannelLayout: 'STEREO',
      transcriptionMode: 'AUTOMATIC',
      transcriptionLanguage: 'th-TH',
      transcriptionMaxAttempts: 3,
      autoQmEnabled: true,
    },
  });

  await prisma.queueSkill.upsert({
    where: { queueId_skillId: { queueId: queue.id, skillId: skill.id } },
    update: {},
    create: { queueId: queue.id, skillId: skill.id, minLevel: 1 },
  });

  await prisma.voiceDestination.upsert({
    where: { tenantId_destination: { tenantId: tenant.id, destination: '2000' } },
    update: { queueId: queue.id, isActive: true },
    create: { tenantId: tenant.id, destination: '2000', queueId: queue.id },
  });
  await prisma.voiceDestination.upsert({
    where: { tenantId_destination: { tenantId: tenant.id, destination: '2001' } },
    update: {
      queueId: queue.id,
      entryMode: 'IVR',
      ivrConfig: {
        prompt: 'Please choose support',
        inputTimeoutSec: 5,
        voiceRoutes: { support: queue.id },
        dtmfRoutes: { '2': queue.id },
      },
      isActive: true,
    },
    create: {
      tenantId: tenant.id,
      destination: '2001',
      entryMode: 'IVR',
      queueId: queue.id,
      ivrConfig: {
        prompt: 'Please choose support',
        inputTimeoutSec: 5,
        voiceRoutes: { support: queue.id },
        dtmfRoutes: { '2': queue.id },
      },
    },
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
    const latestState = await prisma.agentStateLog.findFirst({
      where: { tenantId: tenant.id, userId: agent.id },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { state: true },
    });
    if (latestState?.state !== 'AVAILABLE') {
      await prisma.agentStateLog.create({
        data: { tenantId: tenant.id, userId: agent.id, state: 'AVAILABLE', reason: 'demo-seed' },
      });
    }
  }

  const secondTenant = await prisma.tenant.upsert({
    where: { slug: 'demo-two' },
    update: {},
    create: {
      name: 'Demo Company Two',
      slug: 'demo-two',
      sipDomain: 'demo-two.dcontact.local',
    },
  });
  await prisma.user.upsert({
    where: {
      tenantId_email: { tenantId: secondTenant.id, email: 'admin@demo-two.local' },
    },
    update: {},
    create: {
      tenantId: secondTenant.id,
      email: 'admin@demo-two.local',
      passwordHash,
      displayName: 'Demo Two Admin',
      role: 'ADMIN',
    },
  });
  const secondAgent = await prisma.user.upsert({
    where: {
      tenantId_email: { tenantId: secondTenant.id, email: 'agent2000@demo-two.local' },
    },
    update: {},
    create: {
      tenantId: secondTenant.id,
      email: 'agent2000@demo-two.local',
      passwordHash: agentHash,
      displayName: 'Agent 2000',
      role: 'AGENT',
      extension: '2000',
      sipPassword: 'DContactDev1',
    },
  });
  const secondSkill = await prisma.skill.upsert({
    where: { tenantId_name: { tenantId: secondTenant.id, name: 'general' } },
    update: {},
    create: { tenantId: secondTenant.id, name: 'general' },
  });
  const secondQueue = await prisma.queue.upsert({
    where: { tenantId_name: { tenantId: secondTenant.id, name: 'General Support' } },
    update: {
      recordingEnabled: true,
      recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
      recordingAnnouncementLanguage: 'th-TH',
      recordingAgentSelfAccess: true,
      recordingRetentionDays: 30,
      transcriptionMode: 'AUTOMATIC',
      transcriptionLanguage: 'th-TH',
      transcriptionMaxAttempts: 3,
      autoQmEnabled: true,
    },
    create: {
      tenantId: secondTenant.id,
      name: 'General Support',
      channels: ['VOICE'],
      recordingEnabled: true,
      recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
      recordingAnnouncementLanguage: 'th-TH',
      recordingAgentSelfAccess: true,
      recordingRetentionDays: 30,
      transcriptionMode: 'AUTOMATIC',
      transcriptionLanguage: 'th-TH',
      transcriptionMaxAttempts: 3,
      autoQmEnabled: true,
    },
  });
  await prisma.queueSkill.upsert({
    where: {
      queueId_skillId: { queueId: secondQueue.id, skillId: secondSkill.id },
    },
    update: {},
    create: { queueId: secondQueue.id, skillId: secondSkill.id, minLevel: 1 },
  });
  await prisma.voiceDestination.upsert({
    where: { tenantId_destination: { tenantId: secondTenant.id, destination: '3000' } },
    update: { queueId: secondQueue.id, isActive: true },
    create: { tenantId: secondTenant.id, destination: '3000', queueId: secondQueue.id },
  });
  await prisma.agentSkill.upsert({
    where: { userId_skillId: { userId: secondAgent.id, skillId: secondSkill.id } },
    update: { level: 3 },
    create: { userId: secondAgent.id, skillId: secondSkill.id, level: 3 },
  });
  const secondLatestState = await prisma.agentStateLog.findFirst({
    where: { tenantId: secondTenant.id, userId: secondAgent.id },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { state: true },
  });
  if (secondLatestState?.state !== 'AVAILABLE') {
    await prisma.agentStateLog.create({
      data: {
        tenantId: secondTenant.id,
        userId: secondAgent.id,
        state: 'AVAILABLE',
        reason: 'phase-one-second-tenant-seed',
      },
    });
  }

  console.log(`Seeded tenant "${tenant.slug}" (${tenant.id})`);
  console.log('  admin@demo.local / admin1234');
  console.log('  agent1000@demo.local, agent1001@demo.local / agent1234 (SIP ext 1000, 1001)');
  console.log(`Seeded tenant "${secondTenant.slug}" (${secondTenant.id})`);
  console.log('  admin@demo-two.local / admin1234');
  console.log('  agent2000@demo-two.local / agent1234 (SIP ext 2000)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
