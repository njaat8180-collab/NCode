// Generate the Electron icon files from the approved NCode circle logo.
// Windows System.Drawing keeps the supplied raster artwork intact at each size.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('The NCode icon generator uses Windows System.Drawing and must run on Windows.');
}

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generate-icon.ps1');
const result = spawnSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
], { stdio: 'inherit', windowsHide: true });

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
