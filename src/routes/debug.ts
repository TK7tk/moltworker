import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Debug routes for inspecting container state
 * Note: These routes should be protected by Cloudflare Access middleware
 * when mounted in the main app
 */
const debug = new Hono<AppEnv>();

// GET /debug/version - Returns version info from inside the container
debug.get('/version', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Get OpenClaw version
    const versionProcess = await sandbox.startProcess('openclaw --version');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const versionLogs = await versionProcess.getLogs();
    const moltbotVersion = (versionLogs.stdout || versionLogs.stderr || '').trim();

    // Get node version
    const nodeProcess = await sandbox.startProcess('node --version');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const nodeLogs = await nodeProcess.getLogs();
    const nodeVersion = (nodeLogs.stdout || '').trim();

    return c.json({
      moltbot_version: moltbotVersion,
      node_version: nodeVersion,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', message: `Failed to get version info: ${errorMessage}` }, 500);
  }
});

// GET /debug/processes - List all processes with optional logs
debug.get('/processes', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const includeLogs = c.req.query('logs') === 'true';

    const processData = await Promise.all(
      processes.map(async (p) => {
        const data: Record<string, unknown> = {
          id: p.id,
          command: p.command,
          status: p.status,
          startTime: p.startTime?.toISOString(),
          endTime: p.endTime?.toISOString(),
          exitCode: p.exitCode,
        };

        if (includeLogs) {
          try {
            const logs = await p.getLogs();
            data.stdout = logs.stdout || '';
            data.stderr = logs.stderr || '';
          } catch {
            data.logs_error = 'Failed to retrieve logs';
          }
        }

        return data;
      }),
    );

    // Sort by status (running first, then starting, completed, failed)
    // Within each status, sort by startTime descending (newest first)
    const statusOrder: Record<string, number> = {
      running: 0,
      starting: 1,
      completed: 2,
      failed: 3,
    };

    processData.sort((a, b) => {
      const statusA = statusOrder[a.status as string] ?? 99;
      const statusB = statusOrder[b.status as string] ?? 99;
      if (statusA !== statusB) {
        return statusA - statusB;
      }
      // Within same status, sort by startTime descending
      const timeA = (a.startTime as string) || '';
      const timeB = (b.startTime as string) || '';
      return timeB.localeCompare(timeA);
    });

    return c.json({ count: processes.length, processes: processData });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/gateway-api - Probe the moltbot gateway HTTP API
debug.get('/gateway-api', async (c) => {
  const sandbox = c.get('sandbox');
  const path = c.req.query('path') || '/';
  const MOLTBOT_PORT = 18789;

  try {
    const url = `http://localhost:${MOLTBOT_PORT}${path}`;
    const response = await sandbox.containerFetch(new Request(url), MOLTBOT_PORT);
    const contentType = response.headers.get('content-type') || '';

    let body: string | object;
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return c.json({
      path,
      status: response.status,
      contentType,
      body,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, path }, 500);
  }
});

// GET /debug/cli - Test OpenClaw CLI commands
debug.get('/cli', async (c) => {
  const sandbox = c.get('sandbox');
  const cmd = c.req.query('cmd') || 'openclaw --help';

  try {
    const proc = await sandbox.startProcess(cmd);

    // Wait longer for command to complete
    let attempts = 0;
    while (attempts < 30) {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential polling
      await new Promise((r) => setTimeout(r, 500));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    return c.json({
      command: cmd,
      status: proc.status,
      exitCode: proc.exitCode,
      attempts,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, command: cmd }, 500);
  }
});

// GET /debug/logs - Returns container logs for debugging
debug.get('/logs', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processId = c.req.query('id');
    let process = null;

    if (processId) {
      const processes = await sandbox.listProcesses();
      process = processes.find((p) => p.id === processId);
      if (!process) {
        return c.json(
          {
            status: 'not_found',
            message: `Process ${processId} not found`,
            stdout: '',
            stderr: '',
          },
          404,
        );
      }
    } else {
      process = await findExistingMoltbotProcess(sandbox);
      if (!process) {
        return c.json({
          status: 'no_process',
          message: 'No Moltbot process is currently running',
          stdout: '',
          stderr: '',
        });
      }
    }

    const logs = await process.getLogs();
    return c.json({
      status: 'ok',
      process_id: process.id,
      process_status: process.status,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json(
      {
        status: 'error',
        message: `Failed to get logs: ${errorMessage}`,
        stdout: '',
        stderr: '',
      },
      500,
    );
  }
});

// GET /debug/ws-test - Interactive WebSocket debug page
debug.get('/ws-test', async (c) => {
  const host = c.req.header('host') || 'localhost';
  const protocol = c.req.header('x-forwarded-proto') || 'https';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>WebSocket Debug</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1a1a1a; color: #0f0; }
    #log { white-space: pre-wrap; background: #000; padding: 10px; height: 400px; overflow-y: auto; border: 1px solid #333; }
    button { margin: 5px; padding: 10px; }
    input { padding: 10px; width: 300px; }
    .error { color: #f00; }
    .sent { color: #0ff; }
    .received { color: #0f0; }
    .info { color: #ff0; }
  </style>
</head>
<body>
  <h1>WebSocket Debug Tool</h1>
  <div>
    <button id="connect">Connect</button>
    <button id="disconnect" disabled>Disconnect</button>
    <button id="clear">Clear Log</button>
  </div>
  <div style="margin: 10px 0;">
    <input id="message" placeholder="JSON message to send..." />
    <button id="send" disabled>Send</button>
  </div>
  <div style="margin: 10px 0;">
    <button id="sendConnect" disabled>Send Connect Frame</button>
  </div>
  <div id="log"></div>
  
  <script>
    const wsUrl = '${wsProtocol}://${host}/';
    let ws = null;
    
    const log = (msg, className = '') => {
      const logEl = document.getElementById('log');
      const time = new Date().toISOString().substr(11, 12);
      logEl.innerHTML += '<span class="' + className + '">[' + time + '] ' + msg + '</span>\\n';
      logEl.scrollTop = logEl.scrollHeight;
    };
    
    document.getElementById('connect').onclick = () => {
      log('Connecting to ' + wsUrl + '...', 'info');
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        log('Connected!', 'info');
        document.getElementById('connect').disabled = true;
        document.getElementById('disconnect').disabled = false;
        document.getElementById('send').disabled = false;
        document.getElementById('sendConnect').disabled = false;
      };
      
      ws.onmessage = (e) => {
        log('RECV: ' + e.data, 'received');
        try {
          const parsed = JSON.parse(e.data);
          log('  Parsed: ' + JSON.stringify(parsed, null, 2), 'received');
        } catch {}
      };
      
      ws.onerror = (e) => {
        log('ERROR: ' + JSON.stringify(e), 'error');
      };
      
      ws.onclose = (e) => {
        log('Closed: code=' + e.code + ' reason=' + e.reason, 'info');
        document.getElementById('connect').disabled = false;
        document.getElementById('disconnect').disabled = true;
        document.getElementById('send').disabled = true;
        document.getElementById('sendConnect').disabled = true;
        ws = null;
      };
    };
    
    document.getElementById('disconnect').onclick = () => {
      if (ws) ws.close();
    };
    
    document.getElementById('clear').onclick = () => {
      document.getElementById('log').innerHTML = '';
    };
    
    document.getElementById('send').onclick = () => {
      const msg = document.getElementById('message').value;
      if (ws && msg) {
        log('SEND: ' + msg, 'sent');
        ws.send(msg);
      }
    };
    
    document.getElementById('sendConnect').onclick = () => {
      if (!ws) return;
      const connectFrame = {
        type: 'req',
        id: 'debug-' + Date.now(),
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: 'debug-tool',
            displayName: 'Debug Tool',
            version: '1.0.0',
            mode: 'webchat',
            platform: 'web'
          },
          role: 'operator',
          scopes: []
        }
      };
      const msg = JSON.stringify(connectFrame);
      log('SEND Connect Frame: ' + msg, 'sent');
      ws.send(msg);
    };
    
    document.getElementById('message').onkeypress = (e) => {
      if (e.key === 'Enter') document.getElementById('send').click();
    };
  </script>
</body>
</html>`;

  return c.html(html);
});

// GET /debug/env - Show environment configuration (sanitized)
debug.get('/env', async (c) => {
  return c.json({
    has_anthropic_key: !!c.env.ANTHROPIC_API_KEY,
    has_openai_key: !!c.env.OPENAI_API_KEY,
    has_gateway_token: !!c.env.MOLTBOT_GATEWAY_TOKEN,
    has_r2_access_key: !!c.env.R2_ACCESS_KEY_ID,
    has_r2_secret_key: !!c.env.R2_SECRET_ACCESS_KEY,
    has_cf_account_id: !!c.env.CF_ACCOUNT_ID,
    dev_mode: c.env.DEV_MODE,
    debug_routes: c.env.DEBUG_ROUTES,
    bind_mode: 'lan',
    cf_access_team_domain: c.env.CF_ACCESS_TEAM_DOMAIN,
    has_cf_access_aud: !!c.env.CF_ACCESS_AUD,
  });
});

// GET /debug/container-config - Read the moltbot config from inside the container
debug.get('/container-config', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const proc = await sandbox.startProcess('cat /root/.openclaw/openclaw.json');

    let attempts = 0;
    while (attempts < 10) {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential polling
      await new Promise((r) => setTimeout(r, 200));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    let config = null;
    try {
      config = JSON.parse(stdout);
    } catch {
      // Not valid JSON
    }

    return c.json({
      status: proc.status,
      exitCode: proc.exitCode,
      config,
      raw: config ? undefined : stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/test-api - Test LLM API directly from the WORKER (no container needed)
// Uses Worker env vars to call Google AI / OpenAI compatible endpoint
debug.get('/test-api', async (c) => {
  const model = c.req.query('model') || c.env.CF_AI_GATEWAY_MODEL || '';
  const apiKey = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY || '';
  const accountId = c.env.CF_AI_GATEWAY_ACCOUNT_ID || '';
  const gatewayId = c.env.CF_AI_GATEWAY_GATEWAY_ID || '';

  if (!model) {
    return c.json({ status: 'error', message: 'No CF_AI_GATEWAY_MODEL configured' });
  }
  if (!apiKey) {
    return c.json({ status: 'error', message: 'No CLOUDFLARE_AI_GATEWAY_API_KEY configured' });
  }

  const slashIdx = model.indexOf('/');
  const gwProvider = model.substring(0, slashIdx);
  const modelId = model.substring(slashIdx + 1);

  // Determine the base URL (same logic as start-openclaw.sh)
  let baseUrl: string;
  if (gwProvider === 'google-ai') {
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
  } else if (accountId && gatewayId) {
    baseUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${gwProvider}`;
    if (gwProvider === 'workers-ai') baseUrl += '/v1';
  } else {
    return c.json({ status: 'error', message: 'Cannot determine base URL' });
  }

  const endpoint = `${baseUrl}/chat/completions`;

  const configInfo = {
    gwProvider,
    modelId,
    baseUrl,
    endpoint,
    apiKeyPrefix: apiKey.substring(0, 8) + '...',
  };

  try {
    const startTime = Date.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Say hello in 5 words' }],
        max_tokens: 50,
      }),
    });
    const elapsed = Date.now() - startTime;

    const responseText = await response.text();
    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      // not JSON
    }

    return c.json({
      status: 'ok',
      config: configInfo,
      llm_response: {
        http_status: response.status,
        elapsed_ms: elapsed,
        response: responseJson || responseText,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      status: 'fetch_error',
      config: configInfo,
      error: errorMessage,
    });
  }
});

// GET /debug/test-llm - Test LLM API directly from inside the container
// Reads config, extracts API key/baseUrl, calls the API with a simple prompt
debug.get('/test-llm', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Run a single script inside the container that:
    // 1. Reads openclaw.json
    // 2. Extracts provider config
    // 3. Makes a curl call to the LLM API
    // 4. Returns the raw response
    const testScript = `node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
const providers = config.models && config.models.providers || {};
const providerNames = Object.keys(providers);

if (providerNames.length === 0) {
  console.log(JSON.stringify({ error: 'No providers configured' }));
  process.exit(0);
}

// Find the active provider
const defaultModel = config.agents && config.agents.defaults && config.agents.defaults.model;
const primaryModel = defaultModel && defaultModel.primary || '';
const activeProvider = providerNames.find(n => primaryModel.startsWith(n)) || providerNames[0];
const provider = providers[activeProvider];

console.log(JSON.stringify({
  step: 'config',
  activeProvider,
  primaryModel,
  baseUrl: provider.baseUrl,
  api: provider.api,
  hasApiKey: !!provider.apiKey,
  apiKeyPrefix: provider.apiKey ? provider.apiKey.substring(0, 8) + '...' : null,
  models: provider.models
}));
"`;

    const configProc = await sandbox.startProcess(testScript);
    let attempts = 0;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 500));
      if (configProc.status !== 'running') break;
      attempts++;
    }
    const configLogs = await configProc.getLogs();
    const configStdout = (configLogs.stdout || '').trim();
    const configStderr = (configLogs.stderr || '').trim();

    let configInfo;
    try {
      configInfo = JSON.parse(configStdout);
    } catch {
      return c.json({
        status: 'error',
        message: 'Failed to parse config',
        stdout: configStdout,
        stderr: configStderr,
      });
    }

    if (configInfo.error) {
      return c.json({ status: 'error', ...configInfo });
    }

    // Now make the actual API call using curl inside the container
    const baseUrl = configInfo.baseUrl;
    const isAnthropic = configInfo.api === 'anthropic-messages';

    let curlCmd: string;
    if (isAnthropic) {
      curlCmd = `curl -s -w '\\n---HTTP_STATUS:%{http_code}---' -X POST "${baseUrl}/messages" -H "Content-Type: application/json" -H "x-api-key: $(node -e "const c=JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8'));const p=Object.values(c.models.providers)[0];console.log(p.apiKey)")" -H "anthropic-version: 2023-06-01" -d '{"model":"${configInfo.models?.[0]?.id || 'unknown'}","messages":[{"role":"user","content":"Say hello in 5 words"}],"max_tokens":50}' 2>&1`;
    } else {
      // OpenAI-compatible endpoint (Google AI, etc.)
      curlCmd = `curl -s -w '\\n---HTTP_STATUS:%{http_code}---' -X POST "${baseUrl}/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $(node -e "const c=JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json','utf8'));const ps=c.models.providers;const k=Object.keys(ps);const p=ps[k.find(n=>'${configInfo.primaryModel}'.startsWith(n))||k[0]];console.log(p.apiKey)")" -d '{"model":"${configInfo.models?.[0]?.id || 'unknown'}","messages":[{"role":"user","content":"Say hello in 5 words"}],"max_tokens":50}' 2>&1`;
    }

    const curlProc = await sandbox.startProcess(curlCmd);
    let curlAttempts = 0;
    while (curlAttempts < 30) {
      await new Promise((r) => setTimeout(r, 1000));
      if (curlProc.status !== 'running') break;
      curlAttempts++;
    }
    const curlLogs = await curlProc.getLogs();
    const curlStdout = (curlLogs.stdout || '').trim();
    const curlStderr = (curlLogs.stderr || '').trim();

    // Extract HTTP status code from curl output
    let httpStatus = '';
    let responseBody = curlStdout;
    const statusMatch = curlStdout.match(/---HTTP_STATUS:(\d+)---/);
    if (statusMatch) {
      httpStatus = statusMatch[1];
      responseBody = curlStdout.replace(/\n?---HTTP_STATUS:\d+---/, '').trim();
    }

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseBody);
    } catch {
      // not JSON
    }

    return c.json({
      status: 'ok',
      config: configInfo,
      llm_test: {
        http_status: httpStatus,
        response: parsedResponse || responseBody,
        stderr: curlStderr || undefined,
        curl_status: curlProc.status,
        wait_seconds: curlAttempts,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', message: errorMessage }, 500);
  }
});

export { debug };
