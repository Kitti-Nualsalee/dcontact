import { useCallback, useRef, useState } from 'react';
import { Inviter, Registerer, RegistererState, Session, SessionState, UserAgent } from 'sip.js';
import type { Invitation } from 'sip.js';

const SIP_DOMAIN = 'dcontact.local'; // ตรงกับ vars.xml
const WS_SERVER = 'ws://localhost:5066'; // dev: ws (localhost = secure context) / prod: wss

export type PhoneStatus = 'disconnected' | 'connecting' | 'registered';
export type CallStatus = 'idle' | 'ringing-in' | 'ringing-out' | 'in-call';

export function useSoftphone() {
  const [status, setStatus] = useState<PhoneStatus>('disconnected');
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [remoteParty, setRemoteParty] = useState('');
  const [error, setError] = useState('');

  const uaRef = useRef<UserAgent | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const attachMedia = useCallback((session: Session) => {
    // ดึง remote audio track จาก peer connection มาเล่นใน <audio>
    const sdh = session.sessionDescriptionHandler as unknown as {
      peerConnection?: RTCPeerConnection;
    };
    const pc = sdh?.peerConnection;
    if (!pc || !audioRef.current) return;
    const remoteStream = new MediaStream();
    pc.getReceivers().forEach((receiver) => {
      if (receiver.track) remoteStream.addTrack(receiver.track);
    });
    audioRef.current.srcObject = remoteStream;
    void audioRef.current.play().catch(() => undefined);
  }, []);

  const watchSession = useCallback(
    (session: Session, direction: 'in' | 'out') => {
      sessionRef.current = session;
      setCallStatus(direction === 'in' ? 'ringing-in' : 'ringing-out');
      session.stateChange.addListener((state) => {
        if (state === SessionState.Established) {
          setCallStatus('in-call');
          attachMedia(session);
        }
        if (state === SessionState.Terminated) {
          setCallStatus('idle');
          setRemoteParty('');
          sessionRef.current = null;
        }
      });
    },
    [attachMedia],
  );

  const register = useCallback(
    async (extension: string, password: string) => {
      setError('');
      setStatus('connecting');
      try {
        const uri = UserAgent.makeURI(`sip:${extension}@${SIP_DOMAIN}`);
        if (!uri) throw new Error('invalid SIP URI');

        const ua = new UserAgent({
          uri,
          transportOptions: { server: WS_SERVER },
          authorizationUsername: extension,
          authorizationPassword: password,
          delegate: {
            onInvite(invitation: Invitation) {
              setRemoteParty(invitation.remoteIdentity.uri.user ?? 'unknown');
              watchSession(invitation, 'in');
            },
          },
        });

        await ua.start();
        const registerer = new Registerer(ua);
        registerer.stateChange.addListener((state) => {
          if (state === RegistererState.Registered) setStatus('registered');
          if (state === RegistererState.Unregistered) setStatus('disconnected');
        });
        await registerer.register();
        uaRef.current = ua;
      } catch (e) {
        setStatus('disconnected');
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [watchSession],
  );

  const call = useCallback(
    async (destination: string) => {
      const ua = uaRef.current;
      if (!ua) return;
      setError('');
      try {
        const target = UserAgent.makeURI(`sip:${destination}@${SIP_DOMAIN}`);
        if (!target) throw new Error('invalid destination');
        const inviter = new Inviter(ua, target, {
          sessionDescriptionHandlerOptions: {
            constraints: { audio: true, video: false },
          },
        });
        setRemoteParty(destination);
        watchSession(inviter, 'out');
        await inviter.invite();
      } catch (e) {
        setCallStatus('idle');
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [watchSession],
  );

  const answer = useCallback(async () => {
    const session = sessionRef.current;
    if (session && 'accept' in session) {
      await (session as Invitation).accept({
        sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
      });
    }
  }, []);

  const hangup = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    switch (session.state) {
      case SessionState.Initial:
      case SessionState.Establishing:
        if (session instanceof Inviter) await session.cancel();
        else await (session as Invitation).reject();
        break;
      case SessionState.Established:
        await session.bye();
        break;
      default:
        break;
    }
  }, []);

  return { status, callStatus, remoteParty, error, audioRef, register, call, answer, hangup };
}
