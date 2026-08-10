import { utf8Bytes } from './record-limits.js';
import type { JobRecord, JobStatus } from './types.js';

export const MAX_JOB_LIST_RESPONSE_BYTES = 1024 * 1024;

export interface JobListItem {
  schemaVersion: 1;
  id: string;
  status: JobStatus;
  route: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  attempt: number;
}

export interface JobList {
  schemaVersion: 1;
  jobs: JobListItem[];
  total: number;
  truncated: boolean;
  maxBytes: number;
}

function summarizeJob(job: JobRecord): JobListItem {
  return {
    schemaVersion: 1,
    id: job.id,
    status: job.status,
    route: job.route.name,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    attempt: job.attempt,
  };
}

export function buildJobList(jobs: readonly JobRecord[]): JobList {
  const summaries: JobListItem[] = [];
  const emptyPage: JobList = {
    schemaVersion: 1,
    jobs: [],
    total: jobs.length,
    truncated: true,
    maxBytes: MAX_JOB_LIST_RESPONSE_BYTES,
  };
  // Reserve one byte because `false` is one byte longer than `true`.
  let bytes = utf8Bytes(`${JSON.stringify(emptyPage)}\n`) + 1;

  for (const job of jobs) {
    const summary = summarizeJob(job);
    const addition = utf8Bytes(JSON.stringify(summary)) + (summaries.length === 0 ? 0 : 1);
    if (bytes + addition > MAX_JOB_LIST_RESPONSE_BYTES) break;
    summaries.push(summary);
    bytes += addition;
  }

  const page: JobList = {
    schemaVersion: 1,
    jobs: summaries,
    total: jobs.length,
    truncated: summaries.length < jobs.length,
    maxBytes: MAX_JOB_LIST_RESPONSE_BYTES,
  };
  if (utf8Bytes(`${JSON.stringify(page)}\n`) > MAX_JOB_LIST_RESPONSE_BYTES) {
    throw new Error('Bounded Job list exceeded its response limit');
  }
  return page;
}
