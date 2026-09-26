import fs from 'fs';
import path from 'path';
import { BalanceData, BatchTasksData, TripoResponse, TripoTask, UsageEntry } from './types.js';

export const DEFAULT_BASE_URL = 'https://openapi.tripo3d.ai/v3';

// Above this size, uploads go through a presigned URL (Tripo's recommendation for large files).
const PRESIGN_THRESHOLD_BYTES = 60 * 1024 * 1024;

// Extensions POST /files accepts directly. Anything else that presign accepts goes through presign.
const DIRECT_UPLOAD_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'glb', 'gltf', 'fbx', 'obj', 'stl']);
const PRESIGN_EXTENSIONS = new Set([
  'jpeg', 'jpg', 'png', 'webp', 'bmp', 'tiff',
  'glb', 'gltf', 'fbx', 'obj', 'stl', '3mf', 'usdz',
]);
const IMAGE_EXTENSIONS = new Set(['jpeg', 'jpg', 'png', 'webp', 'bmp', 'tiff']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_BYTES = 150 * 1024 * 1024;

export class TripoApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code?: number,
    public readonly suggestion?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'TripoApiError';
  }
}

export class TripoApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || process.env.TRIPO_API_KEY || process.env.TRIPO_API_SECRET || '';
    this.baseUrl = (baseUrl || process.env.TRIPO_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!this.apiKey) {
      console.error('TRIPO_API_KEY is not set. API calls requiring authentication will fail.');
    }
  }

  private async request<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${route}`, { method, headers, body: payload });
    const text = await response.text();
    let json: TripoResponse<T> | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON body; handled below.
    }

    if (!json) {
      throw new TripoApiError(`Tripo API returned HTTP ${response.status} with a non-JSON body: ${text.slice(0, 200)}`, response.status);
    }
    if (!response.ok || json.code !== 0) {
      throw new TripoApiError(
        json.message || `HTTP ${response.status}`,
        response.status,
        json.code,
        json.suggestion,
        json.request_id,
      );
    }
    return json.data as T;
  }

  // Creates an async task on a V3 endpoint such as "/generation/text-to-model".
  async createTask(route: string, body: Record<string, unknown>): Promise<{ task_id: string }> {
    return this.request('POST', route, body);
  }

  async getTask(taskId: string): Promise<TripoTask> {
    return this.request('GET', `/tasks/${encodeURIComponent(taskId)}`);
  }

  async getTasks(taskIds: string[]): Promise<BatchTasksData> {
    return this.request('POST', '/tasks/list', { task_ids: taskIds });
  }

  async getBalance(): Promise<BalanceData> {
    return this.request('GET', '/account/balance');
  }

  async getUsage(): Promise<UsageEntry[]> {
    return this.request('GET', '/account/usage');
  }

  // Uploads a local image or model file and returns its file_token.
  async uploadFile(filePath: string): Promise<string> {
    const { ext, size } = checkUploadable(filePath);

    if (size <= PRESIGN_THRESHOLD_BYTES && DIRECT_UPLOAD_EXTENSIONS.has(ext)) {
      const form = new FormData();
      const bytes = await fs.promises.readFile(filePath);
      form.append('file', new Blob([bytes]), path.basename(filePath));
      const data = await this.request<{ file_token: string }>('POST', '/files', form);
      return data.file_token;
    }

    const presign = await this.request<{ presigned_url: string; file_token: string }>(
      'POST', '/files/presign', { format: ext },
    );
    const bytes = await fs.promises.readFile(filePath);
    const put = await fetch(presign.presigned_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!put.ok) {
      throw new Error(`Presigned upload of ${path.basename(filePath)} failed with HTTP ${put.status}.`);
    }
    return presign.file_token;
  }

  // Fetches a task output URL. Output URLs are pre-signed, so no auth header is sent.
  async download(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed with HTTP ${response.status}: ${url.split('?')[0]}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

// Identifies common output formats from their leading bytes; Tripo's URL extensions are not always accurate.
export function sniffExtension(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (bytes.toString('ascii', 0, 4) === 'glTF') return '.glb';
  return undefined;
}

// Validates that a local file exists, has a supported extension, and is within Tripo's size limits.
export function checkUploadable(filePath: string): { ext: string; size: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (!PRESIGN_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type ".${ext}". Supported: ${[...PRESIGN_EXTENSIONS].join(', ')}.`);
  }
  const limit = IMAGE_EXTENSIONS.has(ext) ? MAX_IMAGE_BYTES : MAX_MODEL_BYTES;
  if (stat.size > limit) {
    throw new Error(`${path.basename(filePath)} is ${(stat.size / 1048576).toFixed(1)} MB; the limit is ${limit / 1048576} MB.`);
  }
  if (stat.size === 0) {
    throw new Error(`${path.basename(filePath)} is empty.`);
  }
  return { ext, size: stat.size };
}
