import { networkInterfaces } from 'node:os';
import { startLocalRtpRelay, type LocalRtpRelayConfig } from './local-rtp-relay.js';

export function localRtpRelayConfiguration(environment: NodeJS.ProcessEnv): LocalRtpRelayConfig {
  if (
    environment.LOCAL_RTP_RELAY_PROJECT !== 'dcontact-v1b-local' ||
    environment.LOCAL_RTP_RELAY_HOST !== 'workspace.dcontact.test'
  )
    throw new Error('LOCAL_RTP_SCOPE_REFUSED');
  let value: unknown;
  try {
    value = JSON.parse(environment.LOCAL_RTP_RELAY_CONFIG_JSON ?? '');
  } catch {
    throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
  const fields = [
    'publicationAddress',
    'relayMediaAddress',
    'freeSwitchMediaAddress',
    'publicationSubnet',
    'mediaSubnet',
  ];
  if (
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field)) ||
    !('publicationAddress' in value) ||
    typeof value.publicationAddress !== 'string' ||
    !('relayMediaAddress' in value) ||
    typeof value.relayMediaAddress !== 'string' ||
    !('freeSwitchMediaAddress' in value) ||
    typeof value.freeSwitchMediaAddress !== 'string' ||
    !('publicationSubnet' in value) ||
    typeof value.publicationSubnet !== 'string' ||
    !('mediaSubnet' in value) ||
    typeof value.mediaSubnet !== 'string'
  )
    throw new Error('INVALID_LOCAL_RTP_CONFIGURATION');
  return {
    publicationAddress: value.publicationAddress,
    relayMediaAddress: value.relayMediaAddress,
    freeSwitchMediaAddress: value.freeSwitchMediaAddress,
    publicationSubnet: value.publicationSubnet,
    mediaSubnet: value.mediaSubnet,
  };
}

export async function main(): Promise<void> {
  const configuration = localRtpRelayConfiguration(process.env);
  const addresses = Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address),
  );
  if (
    addresses.filter((address) => address === configuration.publicationAddress).length !== 1 ||
    addresses.filter((address) => address === configuration.relayMediaAddress).length !== 1 ||
    addresses.includes(configuration.freeSwitchMediaAddress)
  )
    throw new Error('LOCAL_RTP_INTERFACE_SCOPE_REFUSED');
  const relay = await startLocalRtpRelay(configuration);
  console.log('LOCAL_RTP_RELAY_PUBLICATION_READY_MEDIA_NOT_VERIFIED');
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = (failed: boolean) => {
      if (stopping) return;
      stopping = true;
      clearInterval(monitor);
      process.off('SIGTERM', signal);
      process.off('SIGINT', signal);
      void relay.close().then(
        () => {
          if (failed) reject(new Error('LOCAL_RTP_LISTENER_FAILED'));
          else resolve();
        },
        () => reject(new Error('LOCAL_RTP_SHUTDOWN_FAILED')),
      );
    };
    const signal = () => stop(false);
    const monitor = setInterval(() => {
      const snapshot = relay.snapshot();
      if (!snapshot.ready || snapshot.failureCode) stop(true);
    }, 250);
    process.once('SIGTERM', signal);
    process.once('SIGINT', signal);
  });
}

export function runLocalRtpRelayCli(): void {
  void main().catch(() => {
    console.error('LOCAL_RTP_RELAY_FAILED');
    process.exit(1);
  });
}

if (require.main === module) runLocalRtpRelayCli();
