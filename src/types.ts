export type TaskStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'banned'
  | 'expired'
  | 'cancelled'
  | 'unknown';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['success', 'failed', 'banned', 'expired', 'cancelled']);

export interface TripoTask {
  task_id: string;
  type: string;
  status: TaskStatus;
  progress?: number;
  input?: Record<string, unknown>;
  output?: {
    model_url?: string;
    rendered_image_url?: string;
    generated_image_url?: string;
    [key: string]: unknown;
  };
  error_code?: number;
  error_message?: string;
  credits_consumed?: number;
  created_at?: string;
  completed_at?: string;
}

// Every V3 response uses this envelope: code 0 with data on success, message/suggestion on failure.
export interface TripoResponse<T> {
  code: number;
  status?: string;
  data?: T;
  message?: string;
  suggestion?: string;
  request_id?: string;
}

export interface BatchTasksData {
  tasks: Record<string, TripoTask>;
  missed: string[];
}

export interface BalanceData {
  balance: number;
  frozen: number;
}

export interface UsageEntry {
  task_id: string;
  type: string;
  status?: string;
  credits_consumed: number;
  created_at: string;
}
