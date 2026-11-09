import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@d-contact/ui-react';
import '@d-contact/ui/tokens.css';
import { catalog, type Language } from './catalog.js';
import { browser } from './chrome.js';
import { attachPhoneRuntime, type PhoneStatus } from './runtime.js';
import './phone.css';

declare const __D_PHONE_WORKSPACE_ORIGIN__: string;

function PhoneIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 13v-1a9 9 0 0 1 18 0v1M3 13a2 2 0 0 1 2-2h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2v-3Zm18 0a2 2 0 0 0-2-2h-1a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2v-3Zm-2 5a4 4 0 0 1-4 4h-3" />
    </svg>
  );
}

function PhoneApp() {
  const [language, setLanguage] = useState<Language>('th');
  const text = catalog[language];
  const [status, setStatus] = useState<PhoneStatus>('waiting');
  const [microphone, setMicrophone] = useState<'needed' | 'pending' | 'ready' | 'failed'>('needed');
  const [workspaceTab, setWorkspaceTab] = useState<number>();
  const [audioBlocked, setAudioBlocked] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const micReady = useRef(false);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    return attachPhoneRuntime({
      origin: __D_PHONE_WORKSPACE_ORIGIN__,
      audio: player,
      microphoneReady: () => micReady.current,
      onStatus: setStatus,
      onWorkspaceTab: setWorkspaceTab,
      onAudioBlocked: setAudioBlocked,
    });
  }, []);

  const allowMicrophone = async () => {
    setMicrophone('pending');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      micReady.current = true;
      setMicrophone('ready');
    } catch {
      setMicrophone('failed');
    }
  };

  const playCallAudio = async () => {
    try {
      await audio.current?.play();
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
    }
  };

  const focusWorkspace = async () => {
    if (workspaceTab === undefined) return;
    const tab = await browser.tabs.update(workspaceTab, { active: true }).catch(() => undefined);
    if (tab) await browser.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  };

  const [label, detail] = text.status[status];
  const micLabel = {
    needed: text.micNeeded,
    pending: text.micPending,
    ready: text.micReady,
    failed: text.micFailed,
  }[microphone];

  return (
    <main className="dp-shell">
      <header className="dp-topbar">
        <div className="dp-brand">
          <img src="./d-contact-icon-64.png" width="40" height="40" alt="" />
          <div>
            <h1>D-Phone</h1>
            <p>{text.subtitle}</p>
          </div>
        </div>
        <div className="dp-languages">
          <Button
            size="sm"
            variant={language === 'th' ? 'secondary' : 'ghost'}
            aria-pressed={language === 'th'}
            onPress={() => setLanguage('th')}
          >
            ไทย
          </Button>
          <Button
            size="sm"
            variant={language === 'en' ? 'secondary' : 'ghost'}
            aria-pressed={language === 'en'}
            onPress={() => setLanguage('en')}
          >
            EN
          </Button>
        </div>
      </header>
      <div className="dp-layout">
        <section
          className="dp-card dp-call"
          aria-labelledby="connection-title"
          data-status={status}
        >
          <span className="dp-glyph">
            <PhoneIcon />
          </span>
          <div role="status">
            <h2 id="connection-title" className="dp-section-label">
              {text.connection}
            </h2>
            <p className="dp-state">
              <span className="dp-dot" aria-hidden="true" />
              {label}
            </p>
            <p className="dp-detail">{detail}</p>
          </div>
          {workspaceTab !== undefined && (
            <Button variant="primary" onPress={() => void focusWorkspace()}>
              {text.workspace}
            </Button>
          )}
        </section>
        <div className="dp-setup">
          <section className="dp-card dp-audio" aria-labelledby="audio-title">
            <h2 id="audio-title">{text.audio}</h2>
            <p className="dp-detail" role="status">
              {micLabel}
            </p>
            {microphone !== 'ready' && status !== 'duplicate' && (
              <Button
                variant="primary"
                isDisabled={microphone === 'pending'}
                onPress={() => void allowMicrophone()}
              >
                {microphone === 'failed' ? text.retryMic : text.enableMic}
              </Button>
            )}
            {audioBlocked && (
              <>
                <p className="dp-detail" role="alert">
                  {text.audioBlocked}
                </p>
                <Button variant="primary" onPress={() => void playCallAudio()}>
                  {text.enableAudio}
                </Button>
              </>
            )}
          </section>
          <section className="dp-card" aria-labelledby="setup-title">
            <h2 id="setup-title">{text.instructions}</h2>
            <ol className="dp-steps">
              <li>{text.firstStep}</li>
              <li>{text.secondStep}</li>
              <li>{text.thirdStep}</li>
            </ol>
          </section>
        </div>
      </div>
      <footer className="dp-footer">{text.keepOpen}</footer>
      <audio ref={audio} autoPlay />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<PhoneApp />);
