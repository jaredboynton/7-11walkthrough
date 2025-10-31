#!/usr/bin/env node
/*
Spec Hub sync helper
- Resolves Spec by name in workspace (or creates it), then patches root file content
- Optionally resolves Collection by name (or uses provided UID) and syncs via async endpoint

Inputs (env/args):
  env POSTMAN_API_KEY (required)
  env POSTMAN_WORKSPACE_ID (required)
  args --domain <domain> (optional, defaults to "demo")
  args --service <service> (required)
  args --stage <stage> (required)
  args --openapi <path to openapi.json> (required)
  args --file-path <spec file path> (default: index.json)
  args --spec-id <specId> (optional; otherwise resolve-by-name or create)
  args --collection-uid <collectionUid> (optional; otherwise resolve-by-name)
  args --state-file <path> (default: state/postman-ingestion-state.json)
  args --poll (optional; if set, poll sync task to completion)

Naming conventions:
  specName = `[DEMO] ${service} #main`
  collectionName = `[DEMO] ${service} #main`

Notes:
- Uses Node 18+ global fetch (no external deps)
- Maintains a lightweight state file; falls back to resolve-by-name each run
- If you already know specId/collectionUid, pass them via flags to skip discovery
*/

const fs = require('fs');
const path = require('path');

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

function readJsonFile(p) {
  const b = fs.readFileSync(p);
  return JSON.parse(b.toString());
}

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState(stateFile) {
  try {
    return readJsonFile(stateFile);
  } catch {
    return { entries: {} };
  }
}

function saveState(stateFile, state) {
  ensureDirFor(stateFile);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function key(domain, service, stage) {
  // Sanitize all components (replace spaces with underscores) for state file key
  const sanitizedDomain = (domain || 'demo').replace(/\s+/g, '_');
  const sanitizedService = service.replace(/\s+/g, '_');
  const sanitizedStage = stage.replace(/\s+/g, '_');
  return `${sanitizedDomain}:${sanitizedService}:${sanitizedStage}`;
}

function sanitizeServiceName(service) {
  // Replace spaces with underscores for Postman asset names
  return service.replace(/\s+/g, '_');
}

function transformSpecForPostman(specObj) {
  // Deep clone to avoid mutating original
  const transformed = JSON.parse(JSON.stringify(specObj));
  
  // Remove AWS-specific root-level extensions
  delete transformed['x-amazon-apigateway-cors'];
  delete transformed['x-amazon-apigateway-importexport-version'];
  
  // Filter out AWS CloudFormation tags, keep only meaningful tags
  if (transformed.tags && Array.isArray(transformed.tags)) {
    transformed.tags = transformed.tags.filter(tag => 
      tag.name && !tag.name.startsWith('aws:') && !tag.name.startsWith('httpapi:')
    );
  }
  
  // Transform paths - convert AWS proxy routes to standard OpenAPI
  if (transformed.paths) {
    const transformedPaths = {};
    
    for (const [path, pathItem] of Object.entries(transformed.paths)) {
      const cleanPathItem = {};
      
      // Handle proxy routes (/{proxy+}) by converting x-amazon-apigateway-any-method to common methods
      if (pathItem['x-amazon-apigateway-any-method']) {
        const anyMethod = pathItem['x-amazon-apigateway-any-method'];
        // For proxy routes, create a generic POST method (common for Lambda proxies)
        cleanPathItem.post = {
          summary: `Proxy route: ${path}`,
          description: `Generic proxy route that forwards requests to Lambda function`,
          parameters: pathItem.parameters || [],
          responses: anyMethod.responses || {
            '200': { description: 'Success response' },
            '500': { description: 'Error response' }
          },
          requestBody: {
            description: 'Request body',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        };
        
        // Also add GET for common use cases
        cleanPathItem.get = {
          summary: `Proxy route: ${path}`,
          description: `Generic proxy route that forwards requests to Lambda function`,
          parameters: [
            ...(pathItem.parameters || []),
            {
              name: 'query',
              in: 'query',
              description: 'Query parameters',
              required: false,
              schema: { type: 'object' }
            }
          ],
          responses: anyMethod.responses || {
            '200': { description: 'Success response' },
            '500': { description: 'Error response' }
          }
        };
      } else {
        // For standard paths, copy method operations and clean AWS extensions
        for (const [method, operation] of Object.entries(pathItem)) {
          if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method.toLowerCase())) {
            const cleanOperation = { ...operation };
            // Remove AWS-specific operation extensions
            delete cleanOperation['x-amazon-apigateway-integration'];
            delete cleanOperation['x-amazon-apigateway-request-validator'];
            cleanPathItem[method] = cleanOperation;
          }
        }
      }
      
      // Copy parameters if they exist
      if (pathItem.parameters) {
        cleanPathItem.parameters = pathItem.parameters.map(param => {
          const cleanParam = { ...param };
          delete cleanParam['x-amazon-apigateway-param'];
          return cleanParam;
        });
      }
      
      // Only add path if it has at least one HTTP method
      if (Object.keys(cleanPathItem).length > 0) {
        transformedPaths[path] = cleanPathItem;
      }
    }
    
    transformed.paths = transformedPaths;
  }
  
  // Clean up server URLs - remove template variables if they're just basePath
  if (transformed.servers && Array.isArray(transformed.servers)) {
    transformed.servers = transformed.servers.map(server => {
      const cleaned = { ...server };
      // If server has {basePath} variable and it defaults to stage, simplify
      if (cleaned.variables && cleaned.variables.basePath) {
        const basePath = cleaned.variables.basePath.default || '';
        if (basePath && cleaned.url.includes('{basePath}')) {
          cleaned.url = cleaned.url.replace('{basePath}', basePath);
          delete cleaned.variables.basePath;
          // Remove variables object if empty
          if (Object.keys(cleaned.variables || {}).length === 0) {
            delete cleaned.variables;
          }
        }
      }
      return cleaned;
    });
  }
  
  return transformed;
}

async function pmFetch(pathname, opts = {}) {
  const resp = await fetch(`${API_BASE}${pathname}`, opts);
  if (!resp.ok && resp.status !== 202) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Postman API ${opts.method || 'GET'} ${pathname} failed: ${resp.status} ${resp.statusText}\n${body}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return { resp, data: await resp.json() };
  return { resp, data: await resp.text() };
}

async function createSpec(workspaceId, specName, filePath, fileContent, apiKey) {
  const body = {
    name: specName,
    type: 'OPENAPI:3.0',
    files: [{ path: filePath, content: fileContent }],
  };
  const { data } = await pmFetch(`/specs?workspaceId=${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return data.id || data?.spec?.id || data; // be flexible to future response shapes
}

async function patchSpecFile(specId, filePath, fileContent, apiKey) {
  const { data } = await pmFetch(`/specs/${encodeURIComponent(specId)}/files/${encodeURIComponent(filePath)}`, {
    method: 'PATCH',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: fileContent }), // exactly one property per call
  });
  return data;
}

async function listSpecs(workspaceId, apiKey) {
  const { data } = await pmFetch(`/specs?workspaceId=${encodeURIComponent(workspaceId)}`, {
    headers: { 'x-api-key': apiKey },
  });
  // Expect an array of specs with { id, name, ... }
  return Array.isArray(data?.specs) ? data.specs : (Array.isArray(data) ? data : []);
}

async function findSpecByName(workspaceId, name, apiKey) {
  try {
    const specs = await listSpecs(workspaceId, apiKey);
    return specs.find(s => s.name === name) || null;
  } catch (e) {
    return null;
  }
}

async function listCollections(workspaceId, apiKey) {
  // Prefer workspace-scoped listing; fallback to global listing
  try {
    const { data } = await pmFetch(`/collections?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: { 'x-api-key': apiKey },
    });
    return data?.collections || data?.collection || data || [];
  } catch (e) {
    const { data } = await pmFetch(`/collections`, { headers: { 'x-api-key': apiKey } });
    return data?.collections || data?.collection || data || [];
  }
}

async function findCollectionByName(workspaceId, name, apiKey) {
  try {
    const cols = await listCollections(workspaceId, apiKey);
    return (Array.isArray(cols) ? cols : []).find(c => c.name === name) || null;
  } catch (e) {
    return null;
  }
}


async function syncCollection(collectionUid, specId, apiKey) {
  const { data, resp } = await pmFetch(`/collections/${encodeURIComponent(collectionUid)}/synchronizations?specId=${encodeURIComponent(specId)}`, {
    method: 'PUT',
    headers: { 'x-api-key': apiKey },
  });
  // 202 Accepted; returns { taskId, url }
  return { accepted: resp.status === 202, task: data };
}

async function pollTask(taskUrlPath, apiKey, { timeoutMs = 180000, intervalMs = 3000 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const { data } = await pmFetch(taskUrlPath, { headers: { 'x-api-key': apiKey } });
    last = data;
    if (data?.status && /^(success|failed|completed)$/i.test(String(data.status))) return data;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

(async () => {
  try {
    const args = parseArgs(process.argv);
    const {
      domain = 'demo',
      service,
      stage,
      openapi: openapiPath,
      'file-path': specFilePath = 'index.json',
      'spec-id': specIdArg,
      'collection-uid': collectionUidArg,
      'state-file': stateFile = 'state/postman-ingestion-state.json',
      poll,
    } = args;

    if (!service || !stage || !openapiPath) {
      console.error('Usage: node scripts/spec_sync.js [--domain <domain>] --service <service> --stage <stage> --openapi <openapi.json> [--file-path index.json] [--spec-id SPEC_ID] [--collection-uid UID] [--state-file path] [--poll]');
      console.error('  --domain defaults to "demo" if not provided');
      process.exit(2);
    }

    const POSTMAN_API_KEY = requireEnv('POSTMAN_API_KEY');
    const POSTMAN_WORKSPACE_ID = requireEnv('POSTMAN_WORKSPACE_ID');

    const sanitizedService = sanitizeServiceName(service);
    const specName = `[DEMO] ${sanitizedService} #main`;
    const collectionName = `[DEMO] ${sanitizedService} #main`;
    const state = loadState(stateFile);
    const entryKey = key(domain, service, stage);
    const entry = state.entries[entryKey] || {};

    // read and transform openapi content for Postman compatibility
    const fileStat = fs.statSync(openapiPath);
    if (fileStat.size > 10 * 1024 * 1024) throw new Error('OpenAPI file exceeds 10 MB limit');
    const originalSpec = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
    const transformedSpec = transformSpecForPostman(originalSpec);
    const fileText = JSON.stringify(transformedSpec, null, 2);

    // Resolve/create specId (prefer cached -> arg -> resolve-by-name -> create)
    let specId = entry.specId || specIdArg;
    if (!specId) {
      const found = await findSpecByName(POSTMAN_WORKSPACE_ID, specName, POSTMAN_API_KEY);
      if (found?.id) {
        specId = found.id;
        console.log(`Resolved Spec by name: ${specName} -> ${specId}`);
      } else {
        const createdId = await createSpec(POSTMAN_WORKSPACE_ID, specName, specFilePath, fileText, POSTMAN_API_KEY);
        specId = typeof createdId === 'string' ? createdId : createdId?.id;
        if (!specId) throw new Error('Failed to resolve specId from create response');
        console.log(`Created Spec: ${specId}`);
      }
      entry.specId = specId;
      state.entries[entryKey] = entry;
      saveState(stateFile, state);
    } else {
      console.log(`Using Spec: ${specId}`);
    }

    // Patch spec file content (one-property-per-call)
    await patchSpecFile(specId, specFilePath, fileText, POSTMAN_API_KEY);
    console.log(`Patched spec file ${specFilePath}`);

    // Sync collection if known; otherwise try resolve-by-name
    let collectionUid = entry.collectionUid || collectionUidArg;
    if (!collectionUid) {
      const foundCol = await findCollectionByName(POSTMAN_WORKSPACE_ID, collectionName, POSTMAN_API_KEY);
      if (foundCol?.uid) {
        collectionUid = foundCol.uid;
        console.log(`Resolved Collection by name: ${collectionName} -> ${collectionUid}`);
      }
    }

    if (collectionUid) {
      const { accepted, task } = await syncCollection(collectionUid, specId, POSTMAN_API_KEY);
      console.log(`Sync requested (202 expected): ${accepted}, task: ${JSON.stringify(task)}`);
      if (poll && task?.url) {
        const taskResult = await pollTask(task.url, POSTMAN_API_KEY);
        console.log(`Sync task completed: ${JSON.stringify(taskResult)}`);
      }
      entry.collectionUid = collectionUid;
      state.entries[entryKey] = entry;
      saveState(stateFile, state);
    } else {
      console.log('No collection UID resolved. Generate a collection from the Spec (once) in Postman, then rerun to sync.');
      console.log(`Expected collection name: ${collectionName}`);
    }
  } catch (err) {
    console.error(err.stack || String(err));
    process.exit(1);
  }
})();

