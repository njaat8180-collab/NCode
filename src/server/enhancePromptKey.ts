import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dpapi } from './sarvam.js';

const keyFile = path.join(os.homedir(), '.NCode', 'enhance-prompt-key.dpapi.json');

export function saveEnhancePromptKey(value: string): void {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('Enter a valid API key.');
  const encrypted = dpapi('protect', key);
  if (dpapi('unprotect', encrypted) !== key) throw new Error('Windows secure storage verification failed.');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const temp = `${keyFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ format: 'dpapi-current-user-v1', data: encrypted }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, keyFile);
  } finally { try { fs.unlinkSync(temp); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; } }
}

export function readEnhancePromptKey(): string {
  if (!fs.existsSync(keyFile)) return '';
  const record = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (record?.format !== 'dpapi-current-user-v1' || typeof record.data !== 'string') throw new Error('Saved Enhance Prompt key format is invalid. Re-save the key.');
  return dpapi('unprotect', record.data);
}

export function hasEnhancePromptKey(): boolean { try { return !!readEnhancePromptKey(); } catch { return false; } }
export function clearEnhancePromptKey(): void { try { fs.unlinkSync(keyFile); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; } }
