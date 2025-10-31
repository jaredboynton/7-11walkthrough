#!/usr/bin/env node
/*
Generate and sync collection from Postman Spec

This script automates the manual step of generating a collection from a spec in Postman UI.
It:
1. Finds a spec by name or ID (from state file or by name)
2. Generates a collection from that spec using POST /specs/{specId}/generations/collection
3. Polls the generation task to completion
4. Updates state file with collection UID

Inputs (env/args):
  env POSTMAN_API_KEY (required)
  env POSTMAN_WORKSPACE_ID (required)
  args --domain <domain> (optional, defaults to "demo")
  args --service <service> (required, for naming)
  args --stage <stage> (required, for state file key)
  args --spec-id <specId> (optional; otherwise resolve-by-name or from state)
  args --collection-name <name> (optional; defaults to [DEMO] ${service} #main)
  args --state-file <path> (default: state/postman-ingestion-state.json)

Naming conventions:
  collectionName = `[DEMO] ${service} #main` (default)

Notes:
- Uses Node 18+ global fetch (no external deps)
- Updates state file with collection UID for future reference
- Collections generated from spec are automatically linked to the spec (no separate sync needed)
- Uses Postman API endpoint: POST /specs/:specId/generations/collection
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

async function listSpecs(workspaceId, apiKey) {
  const { data } = await pmFetch(`/specs?workspaceId=${encodeURIComponent(workspaceId)}`, {
    headers: { 'x-api-key': apiKey },
  });
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

async function generateCollectionFromSpec(workspaceId, specId, collectionName, apiKey) {
  // Postman API endpoint for generating collection from spec
  // POST /specs/{specId}/generations/{elementType}
  // elementType = "collection" for generating a collection
  const body = {
    name: collectionName,
    options: {
      requestNameSource: "Fallback",
      indentCharacter: "Space",
      parametersResolution: "Schema",
      folderStrategy: "Paths",
      includeAuthInfoInExample: true,
      enableOptionalParameters: true,
      keepImplicitHeaders: false,
      includeDeprecated: true,
      alwaysInheritAuthentication: false,
      nestedFolderHierarchy: false,
    },
  };
  const { data, resp } = await pmFetch(`/specs/${encodeURIComponent(specId)}/generations/collection?workspaceId=${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  // Returns 202 Accepted with task info for polling
  return { accepted: resp.status === 202, task: data };
}

async function listCollections(workspaceId, apiKey) {
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
      'spec-id': specIdArg,
      'collection-name': collectionNameArg,
      'state-file': stateFile = 'state/postman-ingestion-state.json',
    } = args;

    if (!service || !stage) {
      console.error('Usage: node scripts/generate_synced_collection.js [--domain <domain>] --service <service> --stage <stage> [--spec-id SPEC_ID] [--collection-name NAME] [--state-file path]');
      console.error('  --domain defaults to "demo" if not provided');
      process.exit(2);
    }

    const POSTMAN_API_KEY = requireEnv('POSTMAN_API_KEY');
    const POSTMAN_WORKSPACE_ID = requireEnv('POSTMAN_WORKSPACE_ID');

    const sanitizedService = sanitizeServiceName(service);
    const collectionName = collectionNameArg || `[DEMO] ${sanitizedService} #main`;
    const specName = `[DEMO] ${sanitizedService} #main`;

    // Load state to find specId if not provided
    const state = loadState(stateFile);
    const entryKey = key(domain, service, stage);
    const entry = state.entries[entryKey] || {};
    let specId = specIdArg || entry.specId;

    // Find specId from state or by name
    if (!specId) {
      // Search by name
      const found = await findSpecByName(POSTMAN_WORKSPACE_ID, specName, POSTMAN_API_KEY);
      if (found?.id) {
        specId = found.id;
        console.log(`Resolved Spec by name: ${specName} -> ${specId}`);
        // Update state with specId if we found it
        entry.specId = specId;
        state.entries[entryKey] = entry;
        saveState(stateFile, state);
      } else {
        throw new Error(`Spec not found: ${specName}. Run spec_sync.js first to create the spec.`);
      }
    } else {
      console.log(`Using Spec ID: ${specId}`);
      // Update state if not already set
      if (!entry.specId) {
        entry.specId = specId;
        state.entries[entryKey] = entry;
        saveState(stateFile, state);
      }
    }

    // Check if collection already exists
    const existingCollection = await findCollectionByName(POSTMAN_WORKSPACE_ID, collectionName, POSTMAN_API_KEY);
    if (existingCollection?.uid) {
      console.log(`Collection already exists: ${collectionName} (${existingCollection.uid})`);
      console.log(`To sync it, run: node scripts/spec_sync.js --service "${service}" --stage ${stage} --openapi openapi.json --poll`);
      return;
    }

    // Generate collection from spec
    console.log(`Generating collection "${collectionName}" from spec ${specId}...`);
    const { accepted, task } = await generateCollectionFromSpec(
      POSTMAN_WORKSPACE_ID,
      specId,
      collectionName,
      POSTMAN_API_KEY
    );

    if (!accepted || !task?.url) {
      throw new Error(`Failed to generate collection. Response: ${JSON.stringify(task)}`);
    }

    console.log(`Generation task started: ${JSON.stringify(task)}`);

    // Always poll the task to completion to get the collection UID
    console.log(`Polling generation task...`);
    const taskResult = await pollTask(task.url, POSTMAN_API_KEY);
    console.log(`Generation task completed: ${JSON.stringify(taskResult)}`);

    if (taskResult?.status !== 'success' && taskResult?.status !== 'completed') {
      const errorMsg = taskResult?.details || taskResult?.error?.message || 'Unknown error';
      throw new Error(`Collection generation failed: ${errorMsg}\nFull response: ${JSON.stringify(taskResult, null, 2)}`);
    }

    // Extract collection UID from task result
    // Task result structure: { details: { resources: [{ url: "/collections/{uid}", id: "{uid}" }] } }
    let collectionUid = null;
    
    // Try to extract from resources array in details
    if (taskResult?.details?.resources && Array.isArray(taskResult.details.resources)) {
      const resource = taskResult.details.resources.find(r => r.url?.includes('/collections/'));
      if (resource) {
        collectionUid = resource.id || resource.url?.split('/collections/')[1];
      }
    }
    
    // Fallback to other possible locations
    if (!collectionUid) {
      collectionUid = taskResult?.result?.collection?.uid || 
                       taskResult?.collection?.uid || 
                       taskResult?.result?.uid ||
                       taskResult?.uid;
    }
    
    if (!collectionUid) {
      // If we can't get UID from task result, try to find the collection by name
      console.log(`Warning: Could not extract collection UID from task result. Looking up by name...`);
      const foundCollection = await findCollectionByName(POSTMAN_WORKSPACE_ID, collectionName, POSTMAN_API_KEY);
      if (foundCollection?.uid) {
        console.log(`Found collection by name: ${foundCollection.uid}`);
        collectionUid = foundCollection.uid;
      } else {
        throw new Error(`Failed to extract collection UID and collection not found by name. Task result: ${JSON.stringify(taskResult)}`);
      }
    }

    console.log(`Generated Collection: ${collectionName} (${collectionUid})`);

    // Note: Collection generated from spec is automatically linked to the spec
    console.log(`Collection is automatically linked to spec ${specId}`);

    // Update state file with collection UID using the proper key format
    entry.collectionUid = collectionUid;
    if (!entry.specId) {
      entry.specId = specId;
    }
    state.entries[entryKey] = entry;
    saveState(stateFile, state);
    console.log(`State file updated with collection UID for ${entryKey}`);

  } catch (err) {
    console.error(err.stack || String(err));
    process.exit(1);
  }
})();

