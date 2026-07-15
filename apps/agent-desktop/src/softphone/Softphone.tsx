import { useState } from 'react';
import { useSoftphone } from './useSoftphone';

const box: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
};

export function Softphone() {
  const phone = useSoftphone();
  const [extension, setExtension] = useState('1000');
  const [password, setPassword] = useState('DContactDev1');
  const [destination, setDestination] = useState('9196');

  return (
    <div>
      <div style={box}>
        <strong>1. Register</strong>{' '}
        <span
          style={{
            color: phone.status === 'registered' ? 'green' : '#999',
            fontWeight: 600,
          }}
        >
          [{phone.status}]
        </span>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            value={extension}
            onChange={(e) => setExtension(e.target.value)}
            placeholder="extension"
            style={{ width: 100 }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="SIP password"
          />
          <button
            onClick={() => phone.register(extension, password)}
            disabled={phone.status !== 'disconnected'}
          >
            Register
          </button>
        </div>
      </div>

      <div style={box}>
        <strong>2. Call</strong>{' '}
        {phone.callStatus !== 'idle' && (
          <span style={{ fontWeight: 600 }}>
            [{phone.callStatus}] {phone.remoteParty}
          </span>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="destination (9196 = echo)"
          />
          <button
            onClick={() => phone.call(destination)}
            disabled={phone.status !== 'registered' || phone.callStatus !== 'idle'}
          >
            Call
          </button>
          <button onClick={phone.answer} disabled={phone.callStatus !== 'ringing-in'}>
            Answer
          </button>
          <button onClick={phone.hangup} disabled={phone.callStatus === 'idle'}>
            Hang up
          </button>
        </div>
      </div>

      {phone.error && <p style={{ color: 'crimson' }}>Error: {phone.error}</p>}

      <audio ref={phone.audioRef} autoPlay />
    </div>
  );
}
