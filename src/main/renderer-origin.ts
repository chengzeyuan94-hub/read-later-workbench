import { fileURLToPath } from 'node:url';
export function isRendererFile(url: string, filename: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'file:' && fileURLToPath(parsed) === filename; }
  catch { return false; }
}
