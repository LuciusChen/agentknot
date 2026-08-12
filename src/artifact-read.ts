import { MAX_ARTIFACT_PREVIEW_BYTES } from './workspace-isolation.js';
import type { JobArtifact, JobArtifactReadGrant, JobArtifactReadIdentity } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} has invalid fields` +
        `${unknown.length === 0 ? '' : `; unknown: ${unknown.join(', ')}`}` +
        `${missing.length === 0 ? '' : `; missing: ${missing.join(', ')}`}`
    );
  }
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function hash(value: unknown, label: string, length: number): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value)) {
    throw new Error(`${label} must be ${length} lowercase hexadecimal characters`);
  }
  return value;
}

function gitObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-1 or SHA-256 Git object ID`);
  }
  return value;
}

function artifactIdentity(value: unknown, label: string): JobArtifactReadIdentity {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(
    value,
    ['kind', 'attempt', 'size', 'sha256', 'baseCommit', ...(value.baseTree === undefined ? [] : ['baseTree'])],
    label
  );
  if (value.kind !== 'git-patch') throw new Error(`${label}.kind must be "git-patch"`);
  const size = positiveInteger(value.size, `${label}.size`, MAX_ARTIFACT_PREVIEW_BYTES);
  return {
    kind: 'git-patch',
    attempt: positiveInteger(value.attempt, `${label}.attempt`, Number.MAX_SAFE_INTEGER),
    size,
    sha256: hash(value.sha256, `${label}.sha256`, 64),
    baseCommit: gitObjectId(value.baseCommit, `${label}.baseCommit`),
    ...(value.baseTree === undefined
      ? {}
      : { baseTree: gitObjectId(value.baseTree, `${label}.baseTree`) }),
  };
}

export function validateJobArtifactReadGrant(value: unknown): JobArtifactReadGrant {
  const label = 'Job artifactReadGrant';
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ['schemaVersion', 'sourceJobId', 'artifact'], label);
  if (value.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  if (typeof value.sourceJobId !== 'string' || !/^job_[A-Za-z0-9_-]+$/u.test(value.sourceJobId)) {
    throw new Error(`${label}.sourceJobId is invalid`);
  }
  const artifact = artifactIdentity(value.artifact, `${label}.artifact`);
  return {
    schemaVersion: 1,
    sourceJobId: value.sourceJobId,
    artifact,
  };
}

export function artifactReadIdentity(artifact: JobArtifact): JobArtifactReadIdentity {
  return {
    kind: artifact.kind,
    attempt: artifact.attempt,
    size: artifact.size,
    sha256: artifact.sha256,
    baseCommit: artifact.baseCommit,
    ...(artifact.baseTree === undefined ? {} : { baseTree: artifact.baseTree }),
  };
}

export function artifactIdentityMatches(
  expected: JobArtifactReadIdentity,
  actual: JobArtifact
): boolean {
  return (
    actual.kind === expected.kind &&
    actual.attempt === expected.attempt &&
    actual.size === expected.size &&
    actual.sha256 === expected.sha256 &&
    actual.baseCommit === expected.baseCommit &&
    actual.baseTree === expected.baseTree
  );
}
