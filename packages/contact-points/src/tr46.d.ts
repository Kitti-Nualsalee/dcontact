// tr46@5.1.1 has no type declaration; only toASCII is used to validate the domain, and the result is discarded
declare module 'tr46' {
  export function toASCII(domain: string, options: Record<string, boolean>): string | null;
  const tr46: { toASCII: typeof toASCII };
  export default tr46;
}
