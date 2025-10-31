#!/usr/bin/env node
/*
Upsert a Postman environment for a service/stage (optionally region).

Inputs (env/args):
  env POSTMAN_API_KEY (required)
  env POSTMAN_WORKSPACE_ID (required)
  args --domain <domain> --service <service> --stage <stage> [--region <region>]
  args --openapi <path to openapi.json> (optional; used to derive baseUrl)
  args --base-url <explicit base URL> (optional; overrides any derived value)
  args --env-uid <existing environment UID> (optional; skip lookup)

Naming:
  envName = `[${domain}] ${service} #env-${region? region+'-': ''}${stage}`

Variables written (non-sensitive defaults):
  - baseUrl (from --base-url or openapi.servers[0].url if present)
  - stage (from --stage)
  - region (if provided)
  - apiKey (empty string placeholder)
  - bearerToken (empty string placeholder)

Notes:
  - Uses Postman Environments API: POST /environments?workspaceId=... and PUT /environments/:uid
  - Resolves by name within the workspace when envUid not provided
*/

const fs = require('fs');

const API_BASE = 'https://api.getpostman.com';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.replace(/^--/, '');
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function pmFetch(pathname, opts = {}) {
  const resp = await fetch(`${API_BASE}${pathname}`, opts);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Postman API ${opts.method || 'GET'} ${pathname} failed: ${resp.status} ${resp.statusText}\n${body}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return { resp, data: await resp.json() };
  return { resp, data: await resp.text() };
}

function deriveBaseUrl({ baseUrlArg, openapiPath }) {
  if (baseUrlArg) return baseUrlArg;
  if (openapiPath) {
    try {
      const obj = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
      const url = obj?.servers?.[0]?.url;
      if (typeof url === 'string' && url.trim()) return url.trim();
    } catch (e) {
      // ignore parse errors and fall through
    }
  }
  return '';
}

function buildValues({ baseUrl, stage, region }) {
  const v = [];
  const push = (key, value) => v.push({ key, value: String(value ?? ''), type: 'default', enabled: true });
  if (baseUrl) push('baseUrl', baseUrl);
  push('stage', stage);
  if (region) push('region', region);
  push('apiKey', '');
  push('bearerToken', '');
  return v;
}

async function listEnvironments(workspaceId, apiKey) {
  const { data } = await pmFetch(`/environments?workspaceId=${encodeURIComponent(workspaceId)}`, {
    headers: { 'x-api-key': apiKey },
  });
  // expect { environments: [ { uid, name, ... } ] }
  return data?.environments || data?.environment || data;
}

async function createEnvironment(workspaceId, name, values, apiKey) {
  const body = { environment: { name, values } };
  const { data } = await pmFetch(`/environments?workspaceId=${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return data?.environment?.uid || data?.uid || data;
}

async function updateEnvironment(envUid, name, values, apiKey) {
  const body = { environment: { name, values } };
  const { data } = await pmFetch(`/environments/${encodeURIComponent(envUid)}`, {
    method: 'PUT',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return data?.environment?.uid || envUid;
}

(async () => {
  try {
    const args = parseArgs(process.argv);
    const domain = args.domain;
    const service = args.service;
    const stage = args.stage;
    const region = args.region || '';
    const openapiPath = args.openapi || '';
    const baseUrlArg = args['base-url'] || '';
    const envUidArg = args['env-uid'] || '';

    if (!domain || !service || !stage) {
      console.error('Usage: node scripts/environments_upsert.js --domain <d> --service <s> --stage <st> [--region <r>] [--openapi openapi.json] [--base-url URL] [--env-uid UID]');
      process.exit(2);
    }

    const POSTMAN_API_KEY = requireEnv('POSTMAN_API_KEY');
    const POSTMAN_WORKSPACE_ID = requireEnv('POSTMAN_WORKSPACE_ID');

    const envName = `[${domain}] ${service} #env-${region ? region + '-' : ''}${stage}`;
    const baseUrl = deriveBaseUrl({ baseUrlArg, openapiPath });
    const values = buildValues({ baseUrl, stage, region });

    let envUid = envUidArg;
    if (!envUid) {
      const envs = await listEnvironments(POSTMAN_WORKSPACE_ID, POSTMAN_API_KEY);
      const found = Array.isArray(envs) ? envs.find(e => e.name === envName) : null;
      envUid = found?.uid || '';
    }

    if (envUid) {
      await updateEnvironment(envUid, envName, values, POSTMAN_API_KEY);
      console.log(`Updated environment ${envName} (${envUid})`);
    } else {
      const uid = await createEnvironment(POSTMAN_WORKSPACE_ID, envName, values, POSTMAN_API_KEY);
      console.log(`Created environment ${envName} (${uid})`);
    }

    if (!baseUrl) {
      console.warn('Warning: baseUrl was not set (no --base-url and no servers[0].url).');
    }
  } catch (err) {
    console.error(err.stack || String(err));
    process.exit(1);
  }
})();

