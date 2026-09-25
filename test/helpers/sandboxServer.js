const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');

async function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10_000);
    const onData = (data) => {
      output += data.toString();
      if (output.includes('STICKER SERVER:')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited during startup with code ${code}: ${output}`));
    });
  });
}

/**
 * Starts server.js against an empty library in a temp folder and returns a
 * dashboard-authenticated client. Never points at the real output folder.
 */
async function startSandboxServer(prefix = 'stickers-sandbox-test-') {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outputDir = path.join(sandbox, 'output');
  const tempDir = path.join(sandbox, 'temp');
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), INGEST_TOKEN: '', STICKER_OUTPUT_DIR: outputDir, STICKER_TEMP_DIR: tempDir },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForReady(child);

  const session = await fetch(`${origin}/api/session`, { headers: { Origin: origin } });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const headers = { Origin: origin, Cookie: cookie };

  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`${origin}${route}`, {
      method,
      headers: body === undefined || body instanceof FormData ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body)
    });
    let json = null;
    try {
      json = await response.json();
    } catch (_) {
      json = null;
    }
    return { status: response.status, body: json };
  };

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  };

  return { origin, port, cookie, headers, outputDir, tempDir, request, stop };
}

module.exports = { startSandboxServer };
