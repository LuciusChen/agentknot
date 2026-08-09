import { spawn } from 'node:child_process';

const TIMEOUT_MS = 60_000;
const TERMINATION_GRACE_MS = 2_000;
const TEST_FILES = [
  'dist/test/cli-signal.test.js',
  'dist/test/pi-rpc.test.js',
  'dist/test/runtime.test.js',
  'dist/test/workspace-isolation.test.js',
];

if (process.platform === 'win32') {
  throw new Error('Stage 1 soak process-group supervision requires a POSIX host.');
}

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...TEST_FILES], {
  detached: true,
  stdio: 'inherit',
});
const processGroupId = child.pid;
if (processGroupId === undefined) throw new Error('Stage 1 soak test runner did not start.');

function groupAlive() {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function signalGroup(signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForGroupExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

async function terminateGroup() {
  signalGroup('SIGTERM');
  if (await waitForGroupExit(TERMINATION_GRACE_MS)) return;
  signalGroup('SIGKILL');
  if (!(await waitForGroupExit(TERMINATION_GRACE_MS))) {
    throw new Error(`Process group ${processGroupId} remained after SIGKILL.`);
  }
}

let terminationReason;
let forceKillTimer;
function requestTermination(reason) {
  if (terminationReason !== undefined) return;
  terminationReason = reason;
  console.error(`Stage 1 soak ${reason}; terminating process group ${processGroupId}.`);
  signalGroup('SIGTERM');
  forceKillTimer = setTimeout(() => signalGroup('SIGKILL'), TERMINATION_GRACE_MS);
  forceKillTimer.unref();
}

const onSigint = () => requestTermination('received SIGINT');
const onSigterm = () => requestTermination('received SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);
const timeout = setTimeout(
  () => requestTermination(`exceeded ${TIMEOUT_MS} ms`),
  TIMEOUT_MS
);
timeout.unref();

const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
}).finally(() => {
  clearTimeout(timeout);
  clearTimeout(forceKillTimer);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
});

if (terminationReason !== undefined || groupAlive()) {
  if (terminationReason === undefined) {
    console.error(
      `Stage 1 soak detected descendants after test-runner exit in process group ${processGroupId}.`
    );
  }
  await terminateGroup();
  process.exitCode = 1;
} else if (result.signal !== null) {
  console.error(`Stage 1 soak test runner exited on ${result.signal}.`);
  process.exitCode = 1;
} else {
  process.exitCode = result.code ?? 1;
}
