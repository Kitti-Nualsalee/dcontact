// tr46@5.1.1 ไม่มี type declaration; ใช้เฉพาะ toASCII เพื่อ validate domain แล้วทิ้งผล
declare module 'tr46' {
  export function toASCII(domain: string, options: Record<string, boolean>): string | null;
  const tr46: { toASCII: typeof toASCII };
  export default tr46;
}
