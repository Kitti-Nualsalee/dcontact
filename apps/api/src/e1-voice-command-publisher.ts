import type { VoiceOriginateCommandPublisher } from '@d-contact/delivery';

export class E1VoiceCommandPublisher implements VoiceOriginateCommandPublisher {
  constructor(
    private readonly secret: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('E1_VOICE_COMMAND_SECRET_REQUIRED');
  }

  async publish(input: Parameters<VoiceOriginateCommandPublisher['publish']>[0]): Promise<void> {
    try {
      const response = await this.request('http://e1-sandbox:3001/commands', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (response.status !== 202) throw new Error('unconfirmed');
    } catch {
      throw new Error('E1_VOICE_COMMAND_UNCONFIRMED');
    }
  }
}
