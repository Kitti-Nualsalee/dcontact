import { Softphone } from './softphone/Softphone';

export function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 480, margin: '40px auto' }}>
      <h1>D-Contact — Softphone Spike</h1>
      <p style={{ color: '#666' }}>
        Phase 0 spike: ทดสอบ WebRTC ผ่าน FreeSWITCH — เปิด 2 แท็บ ลงทะเบียน ext 1000 และ 1001
        แล้วโทรหากัน หรือโทร <code>9196</code> (echo test)
      </p>
      <Softphone />
    </div>
  );
}
