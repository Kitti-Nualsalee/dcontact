/**
 * Device-test button at the bottom left (#939, per docs/agent-readiness-setup.md) — optional, not a step before taking calls
 * a panel floating above the button, not a modal: close it with the close button, the same button again, or Esc
 * the devices chosen here are what the next call uses (SipJsBrowserTransport reads from devicePreferences)
 * test results and device names stay in the browser only
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Select, type BadgeTone, type SelectOption } from '@d-contact/ui-react';
import {
  devicePreferences,
  micConstraint,
  rememberedDeviceMissing,
  routeToSpeaker,
  supportsSpeakerSelection,
} from './device-preferences.js';
import { createSpeechDetector, micFailure, rmsLevel, type MicFailure } from './device-test.js';
import { PaneIcon } from './workspace-pane.js';

type MicState =
  | { phase: 'starting' }
  | { phase: 'listening' | 'quiet' | 'pass' }
  | { phase: 'error'; failure: MicFailure };
type SpeakerState = 'idle' | 'asking' | 'pass' | 'fail';
type StepTone = 'run' | 'pass' | 'warn' | 'fail' | 'idle';

const DEFAULT_DEVICE = 'default';
const METER_BARS = 24;
const SAMPLE_MS = 100;
const RECORD_MS = 3_000;

export function DeviceTestButton({ inCall }: { inCall: boolean }) {
  const { t, i18n } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useSyncExternalStore(devicePreferences.subscribe, devicePreferences.version);
  const last = devicePreferences.lastTest();

  // the mic is in use talking to a customer — close the panel when a call arrives while it is open
  useEffect(() => {
    if (inCall) setOpen(false);
  }, [inCall]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const summary = inCall
    ? t('deviceTest.afterCall')
    : last
      ? t(last.result === 'pass' ? 'deviceTest.lastPass' : 'deviceTest.lastWarn', {
          when: formatWhen(last.at, i18n.language, t('deviceTest.today')),
        })
      : t('deviceTest.never');
  const tone = last?.result ?? 'none';

  return (
    <div className="aw-devtest">
      {open ? <DeviceTestPanel id={panelId} onClose={close} /> : null}
      <button
        ref={button}
        type="button"
        className="aw-devtest-button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-disabled={inCall || undefined}
        onClick={() => {
          if (!inCall) setOpen((value) => !value);
        }}
      >
        <PaneIcon name="readiness" />
        <span className="aw-devtest-copy">
          <span className="aw-devtest-label">{t('deviceTest.button')}</span>
          <small>{summary}</small>
        </span>
        <span className={`aw-devtest-dot aw-devtest-dot-${tone}`} aria-hidden="true" />
      </button>
    </div>
  );
}

function DeviceTestPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation('workspace');
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const [mic, setMic] = useState<MicState>({ phase: 'starting' });
  const [speaker, setSpeaker] = useState<SpeakerState>('idle');

  useEffect(() => {
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // summary on the button: everything tested passes = pass; anything failing = something to check
  const micDone = mic.phase === 'pass' || mic.phase === 'error' || mic.phase === 'quiet';
  const speakerDone = speaker === 'pass' || speaker === 'fail';
  const micOk = mic.phase === 'pass';
  const outcome =
    (micDone && !micOk) || speaker === 'fail'
      ? 'warn'
      : (micOk && speaker !== 'asking') || (speakerDone && speaker === 'pass')
        ? 'pass'
        : undefined;
  useEffect(() => {
    if (outcome) devicePreferences.setLastTest({ result: outcome, at: new Date().toISOString() });
  }, [outcome]);

  return (
    <section
      ref={panel}
      id={id}
      className="aw-devtest-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="aw-devtest-head">
        <div>
          <h2 id={titleId}>{t('deviceTest.title')}</h2>
          <p>{t('deviceTest.description')}</p>
        </div>
        <Button variant="ghost" size="sm" onPress={onClose}>
          {t('deviceTest.close')}
        </Button>
      </header>
      <MicTest state={mic} onState={setMic} />
      <SpeakerTest state={speaker} onState={setSpeaker} />
    </section>
  );
}

function MicTest({ state, onState }: { state: MicState; onState: (state: MicState) => void }) {
  const { t } = useTranslation('workspace');
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [recording, setRecording] = useState<'idle' | 'recording' | 'playing'>('idle');
  const stream = useRef<MediaStream | undefined>(undefined);
  const micId = devicePreferences.devices().micId;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    let disposed = false;
    let context: AudioContext | undefined;
    let timer: number | undefined;
    onStateRef.current({ phase: 'starting' });
    void (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: micConstraint(devicePreferences.devices()),
        });
        if (disposed) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        stream.current = media;
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (!disposed) setInputs(devices.filter((device) => device.kind === 'audioinput'));
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(media).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const detector = createSpeechDetector();
        onStateRef.current({ phase: 'listening' });
        let previous: MicState['phase'] = 'listening';
        timer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          const rms = rmsLevel(samples);
          setLevel(rms);
          const result = detector.sample(rms, performance.now());
          if (result !== previous) {
            previous = result;
            onStateRef.current({ phase: result });
          }
        }, SAMPLE_MS);
      } catch (error) {
        if (!disposed) onStateRef.current({ phase: 'error', failure: micFailure(error) });
      }
    })();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void context?.close().catch(() => undefined);
      for (const track of stream.current?.getTracks() ?? []) track.stop();
      stream.current = undefined;
    };
  }, [micId, attempt]);

  const options = deviceOptions(inputs, t('deviceTest.systemDefault'), (index) =>
    t('deviceTest.micFallbackName', { index }),
  );
  const missing = rememberedDeviceMissing(micId, inputs);
  const tone: StepTone =
    state.phase === 'pass'
      ? 'pass'
      : state.phase === 'error'
        ? 'fail'
        : state.phase === 'quiet'
          ? 'warn'
          : 'run';

  const recordAndPlay = async () => {
    if (!stream.current || typeof MediaRecorder === 'undefined') return;
    setRecording('recording');
    try {
      const recorder = new MediaRecorder(stream.current);
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', (event) => chunks.push(event.data));
      const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve));
      recorder.start();
      await new Promise((resolve) => window.setTimeout(resolve, RECORD_MS));
      recorder.stop();
      await stopped;
      setRecording('playing');
      // audio recorded lives only in this page's memory and is released right after playback ends
      const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
      const player = new Audio(url);
      await routeToSpeaker(player, devicePreferences.devices().speakerId);
      await new Promise<void>((resolve) => {
        player.addEventListener('ended', () => resolve(), { once: true });
        player.addEventListener('error', () => resolve(), { once: true });
        void player.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } finally {
      setRecording('idle');
    }
  };

  return (
    <section className="aw-devtest-step" aria-labelledby="aw-devtest-mic">
      <div className="aw-devtest-step-head">
        <h3 id="aw-devtest-mic">{t('deviceTest.mic.title')}</h3>
        <StepBadge tone={tone} label={t(`deviceTest.mic.state.${state.phase}`)} />
      </div>
      {state.phase === 'error' ? null : (
        <Select
          label={t('deviceTest.mic.device')}
          options={options}
          selectedKey={micId ?? DEFAULT_DEVICE}
          onSelectionChange={(key) =>
            devicePreferences.setDevices({
              micId: key === DEFAULT_DEVICE ? undefined : String(key),
            })
          }
        />
      )}
      {missing ? <p className="aw-devtest-note">{t('deviceTest.missingDevice')}</p> : null}
      {state.phase === 'error' ? (
        <div className="aw-devtest-callout aw-devtest-callout-fail" role="alert">
          <strong>{t(`deviceTest.mic.failure.${state.failure}.title`)}</strong>
          <span>{t(`deviceTest.mic.failure.${state.failure}.fix`)}</span>
          <Button size="sm" onPress={() => setAttempt((value) => value + 1)}>
            {t('deviceTest.retry')}
          </Button>
        </div>
      ) : (
        <>
          <p className="aw-devtest-prompt">{t('deviceTest.mic.prompt')}</p>
          <Meter level={state.phase === 'starting' ? 0 : level} label={t('deviceTest.mic.meter')} />
          <p className="aw-devtest-status" role="status">
            {t(`deviceTest.mic.hint.${state.phase}`)}
          </p>
          <div className="aw-devtest-row">
            <Button
              size="sm"
              isDisabled={state.phase === 'starting' || recording !== 'idle'}
              onPress={() => void recordAndPlay()}
            >
              {t(`deviceTest.mic.record.${recording}`)}
            </Button>
            <span className="aw-devtest-note">{t('deviceTest.mic.recordNote')}</span>
          </div>
        </>
      )}
    </section>
  );
}

function SpeakerTest({
  state,
  onState,
}: {
  state: SpeakerState;
  onState: (state: SpeakerState) => void;
}) {
  const { t } = useTranslation('workspace');
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [playing, setPlaying] = useState(false);
  const [selectable] = useState(() => supportsSpeakerSelection(new Audio()));
  const speakerId = devicePreferences.devices().speakerId;

  useEffect(() => {
    let disposed = false;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (!disposed) setOutputs(devices.filter((device) => device.kind === 'audiooutput'));
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  const play = async () => {
    setPlaying(true);
    onState('asking');
    try {
      await playTestTone(speakerId);
    } finally {
      setPlaying(false);
    }
  };

  const tone: StepTone =
    state === 'pass' ? 'pass' : state === 'fail' ? 'fail' : state === 'asking' ? 'run' : 'idle';
  const options = deviceOptions(outputs, t('deviceTest.systemDefault'), (index) =>
    t('deviceTest.speaker.fallbackName', { index }),
  );

  return (
    <section className="aw-devtest-step" aria-labelledby="aw-devtest-speaker">
      <div className="aw-devtest-step-head">
        <h3 id="aw-devtest-speaker">{t('deviceTest.speaker.title')}</h3>
        <StepBadge tone={tone} label={t(`deviceTest.speaker.state.${state}`)} />
      </div>
      {selectable ? (
        <Select
          label={t('deviceTest.speaker.device')}
          options={options}
          selectedKey={speakerId ?? DEFAULT_DEVICE}
          onSelectionChange={(key) => {
            devicePreferences.setDevices({
              speakerId: key === DEFAULT_DEVICE ? undefined : String(key),
            });
            onState('idle');
          }}
        />
      ) : (
        <p className="aw-devtest-note">{t('deviceTest.speaker.unsupported')}</p>
      )}
      {selectable && rememberedDeviceMissing(speakerId, outputs) ? (
        <p className="aw-devtest-note">{t('deviceTest.missingDevice')}</p>
      ) : null}
      {state === 'fail' ? (
        <div className="aw-devtest-callout aw-devtest-callout-fail" role="alert">
          <strong>{t('deviceTest.speaker.failTitle')}</strong>
          <span>{t('deviceTest.speaker.failFix')}</span>
        </div>
      ) : null}
      <div className="aw-devtest-row">
        <Button size="sm" isDisabled={playing} onPress={() => void play()}>
          {t(state === 'idle' ? 'deviceTest.speaker.play' : 'deviceTest.speaker.playAgain')}
        </Button>
        <span className="aw-devtest-note">{t('deviceTest.speaker.playNote')}</span>
      </div>
      {state !== 'idle' ? (
        <div className="aw-devtest-ask" role="group" aria-labelledby="aw-devtest-heard">
          <strong id="aw-devtest-heard">{t('deviceTest.speaker.ask')}</strong>
          <Button
            size="sm"
            variant={state === 'pass' ? 'primary' : 'secondary'}
            onPress={() => onState('pass')}
          >
            {t('deviceTest.speaker.heard')}
          </Button>
          <Button size="sm" onPress={() => onState('fail')}>
            {t('deviceTest.speaker.notHeard')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function StepBadge({ tone, label }: { tone: StepTone; label: string }) {
  const badgeTone: BadgeTone =
    tone === 'pass'
      ? 'success'
      : tone === 'fail'
        ? 'critical'
        : tone === 'warn'
          ? 'attention'
          : tone === 'run'
            ? 'info'
            : 'neutral';
  return <Badge tone={badgeTone}>{label}</Badge>;
}

function Meter({ level, label }: { level: number; label: string }) {
  // RMS of normal speech is about 0.02–0.2 — amplify so the bar moves enough to be seen
  const lit = Math.min(METER_BARS, Math.round(Math.sqrt(Math.min(1, level * 4)) * METER_BARS));
  return (
    <div
      className="aw-devtest-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={METER_BARS}
      aria-valuenow={lit}
    >
      {Array.from({ length: METER_BARS }, (_, index) => (
        <span key={index} className={index < lit ? 'aw-devtest-bar-on' : undefined} />
      ))}
    </div>
  );
}

function deviceOptions(
  devices: readonly MediaDeviceInfo[],
  systemDefault: string,
  fallback: (index: number) => string,
): SelectOption[] {
  const options: SelectOption[] = [{ id: DEFAULT_DEVICE, label: systemDefault }];
  devices.forEach((device, index) => {
    if (!device.deviceId || device.deviceId === DEFAULT_DEVICE) return;
    options.push({ id: device.deviceId, label: device.label || fallback(index + 1) });
  });
  return options;
}

/** a two-beat test sound like a ringtone, sent to the chosen speaker through <audio> so setSinkId can be used */
async function playTestTone(speakerId: string | undefined): Promise<void> {
  const context = new AudioContext();
  try {
    const destination = context.createMediaStreamDestination();
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(destination);
    for (const frequency of [440, 480]) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
    }
    const start = context.currentTime + 0.05;
    for (const offset of [0, 0.6]) {
      gain.gain.setValueAtTime(0.2, start + offset);
      gain.gain.setValueAtTime(0, start + offset + 0.4);
    }
    const player = new Audio();
    player.srcObject = destination.stream;
    await routeToSpeaker(player, speakerId);
    await player.play().catch(() => undefined);
    await new Promise((resolve) => window.setTimeout(resolve, 1_200));
    player.pause();
    player.srcObject = null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

function formatWhen(iso: string, locale: string, todayLabel: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  if (at.toDateString() === new Date().toDateString()) return `${todayLabel} ${time}`;
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at);
  return `${day} ${time}`;
}
