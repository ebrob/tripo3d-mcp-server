import os from 'os';
import path from 'path';
import fs from 'fs';
import { TripoApi, checkUploadable } from './api.js';

// Resolves a user-supplied source into a value for a V3 `input` field.
// - http(s) URLs pass through unchanged.
// - Existing local files are uploaded and replaced by their file_token
//   (or by a placeholder when dryRun is set, so nothing is uploaded).
// - Anything else (a file_… token or a task UUID) passes through for the API to interpret.
export async function resolveInput(api: TripoApi, source: string, dryRun = false): Promise<string> {
  const value = source.trim();
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  const localPath = expandPath(value);
  if (fs.existsSync(localPath)) {
    checkUploadable(localPath);
    if (dryRun) {
      return `<file_token for ${path.basename(localPath)}>`;
    }
    return api.uploadFile(localPath);
  }

  if (looksLikePath(value)) {
    throw new Error(`File not found: ${localPath}`);
  }
  return value;
}

// Resolves a source into the object form ({url} or {file_token}) that some nested fields use.
export async function resolveInputObject(
  api: TripoApi,
  source: string,
  dryRun = false,
): Promise<{ url: string } | { file_token: string }> {
  const value = await resolveInput(api, source, dryRun);
  return /^https?:\/\//i.test(value) ? { url: value } : { file_token: value };
}

export function expandPath(value: string): string {
  if (value === '~' || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(1));
  }
  return path.resolve(value);
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || value.startsWith('~') || /\.[a-z0-9]{2,5}$/i.test(value);
}
