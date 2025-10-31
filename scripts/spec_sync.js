#!/usr/bin/env node
/*
Spec Hub sync helper
- Resolves Spec by name in workspace (or creates it), then patches root file content
- Automatically generates collection if none exists (POST /specs/{specId}/generations/collection)
- Automatically syncs collection if it exists (PUT /collections/{collectionUid}/synchronizations)
- Resolves Collection UID via: state file -> spec's generated collections -> name lookup

Inputs (env/args):
  env POSTMAN_API_KEY (required)
  env POSTMAN_WORKSPACE_ID (required)
  args --domain <domain> (optional, defaults to "demo")
  args --service <service> (required)
  args --stage <stage> (required)
  args --openapi <path to openapi.json> (required)
  args --file-path <spec file path> (default: index.json)
  args --spec-id <specId> (optional; otherwise resolve-by-name or create)
  args --collection-uid <collectionUid> (optional; otherwise auto-detect)
  args --state-file <path> (default: state/postman-ingestion-state.json)
  args --poll (optional; if set, poll sync/generation tasks to completion)

Naming conventions:
  specName = `[DEMO] ${service} #main`
  collectionName = `[DEMO] ${service} #main`

Notes:
- Uses Node 18+ global fetch (no external deps)
- Maintains a lightweight state file; falls back to resolve-by-name each run
- If you already know specId/collectionUid, pass them via flags to skip discovery
- Generation tasks are always polled to completion to extract collection UID
- Sync tasks are only polled if --poll flag is provided
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

// ============================================================================
// Multi-Environment Configuration Support
// ============================================================================

function loadEnvironmentConfig(configPath = 'config/environments.json') {
  try {
    if (!fs.existsSync(configPath)) {
      console.log(`No environment config found at ${configPath}, skipping multi-env setup`);
      return null;
    }
    return readJsonFile(configPath);
  } catch (err) {
    console.warn(`Failed to load environment config: ${err.message}`);
    return null;
  }
}

function getServiceEnvironments(config, service) {
  if (!config || !config.services) return [];
  const sanitizedService = sanitizeServiceName(service);
  const serviceConfig = config.services[sanitizedService] || config.services[service];
  if (!serviceConfig) return [];
  return (serviceConfig.environments || []).filter(env => env.enabled !== false);
}

function enrichSpecWithEnvironments(spec, service, config) {
  const envs = getServiceEnvironments(config, service);
  if (!envs || envs.length === 0) {
    console.log(`No environments configured for ${service}, keeping original servers block`);
    return spec;
  }

  const sanitizedService = sanitizeServiceName(service);
  const serviceConfig = config.services[sanitizedService] || config.services[service];
  const urlPattern = serviceConfig.apiUrlPattern;

  // Extract unique values for enum lists
  const regions = [...new Set(envs.map(e => e.region))];
  const stages = [...new Set(envs.map(e => e.stage))];
  const apiIds = [...new Set(envs.map(e => e.apiId).filter(Boolean))];

  // Build server entry with template variables
  const serverEntry = {
    url: urlPattern,
    description: `AWS API Gateway endpoint (multi-region, ${envs.length} environments configured)`,
    variables: {}
  };

  // Add variables based on what's in the URL pattern
  if (urlPattern.includes('{apiId}')) {
    serverEntry.variables.apiId = {
      default: apiIds[0] || envs[0]?.apiId || 'API_ID',
      description: 'API Gateway ID',
    };
    if (apiIds.length > 1) {
      serverEntry.variables.apiId.enum = apiIds;
    }
  }

  if (urlPattern.includes('{region}')) {
    serverEntry.variables.region = {
      default: regions[0],
      enum: regions,
      description: 'AWS region'
    };
  }

  if (urlPattern.includes('{stage}')) {
    serverEntry.variables.stage = {
      default: stages[0],
      enum: stages,
      description: 'Deployment stage'
    };
  }

  spec.servers = [serverEntry];
  console.log(`Enriched spec with ${envs.length} environments: ${envs.map(e => e.name).join(', ')}`);
  
  return spec;
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

async function getSpecCollections(specId, apiKey) {
  // GET /specs/{specId}/collections - Get a spec's generated collections
  try {
    const { data } = await pmFetch(`/specs/${encodeURIComponent(specId)}/collections`, {
      headers: { 'x-api-key': apiKey },
    });
    // Response may be { collections: [...] } or just array
    return Array.isArray(data?.collections) ? data.collections : (Array.isArray(data) ? data : []);
  } catch (e) {
    return [];
  }
}

async function generateCollectionFromSpec(workspaceId, specId, collectionName, apiKey) {
  // POST /specs/{specId}/generations/collection - Generate a collection from spec
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

async function syncCollection(collectionUid, specId, apiKey) {
  // PUT /collections/{collectionUid}/synchronizations?specId={specId} - Sync collection with spec
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

async function listEnvironments(workspaceId, apiKey) {
  try {
    const { data } = await pmFetch(`/environments?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: { 'x-api-key': apiKey },
    });
    return data?.environments || data || [];
  } catch (e) {
    return [];
  }
}

async function findEnvironmentByName(workspaceId, name, apiKey) {
  try {
    const envs = await listEnvironments(workspaceId, apiKey);
    return (Array.isArray(envs) ? envs : []).find(e => e.name === name) || null;
  } catch (e) {
    return null;
  }
}

async function upsertEnvironment(workspaceId, name, variables, apiKey, existingUid = null) {
  const envBody = {
    name,
    values: variables
  };

  if (existingUid) {
    // Update existing environment
    try {
      const { data } = await pmFetch(`/environments/${encodeURIComponent(existingUid)}`, {
        method: 'PUT',
        headers: { 
          'x-api-key': apiKey, 
          'content-type': 'application/json' 
        },
        body: JSON.stringify({ environment: envBody })
      });
      return data.environment?.uid || existingUid;
    } catch (err) {
      console.warn(`Failed to update environment ${name} (${existingUid}), will try to create new one: ${err.message}`);
    }
  }

  // Create new environment (or fallback if update failed)
  const { data } = await pmFetch(`/environments?workspaceId=${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    headers: { 
      'x-api-key': apiKey, 
      'content-type': 'application/json' 
    },
    body: JSON.stringify({ environment: envBody })
  });
  return data.environment?.uid || data.uid;
}

async function createEnvironmentsFromConfig(workspaceId, domain, service, config, apiKey, stateEntry) {
  const envs = getServiceEnvironments(config, service);
  if (!envs || envs.length === 0) {
    console.log(`No environments configured for ${service}, skipping environment creation`);
    return {};
  }

  const sanitizedService = sanitizeServiceName(service);
  const serviceConfig = config.services[sanitizedService] || config.services[service];
  const urlPattern = serviceConfig.apiUrlPattern;
  const createdEnvs = {};

  console.log(`Creating/updating ${envs.length} Postman environments...`);

  for (const env of envs) {
    const envName = `[${domain}] ${sanitizedService} #${env.name}`;
    
    // Build baseUrl by replacing template variables
    let baseUrl = urlPattern;
    baseUrl = baseUrl.replace('{apiId}', env.apiId || '{apiId}');
    baseUrl = baseUrl.replace('{region}', env.region || '{region}');
    baseUrl = baseUrl.replace('{stage}', env.stage || '{stage}');

    const envVars = [
      { key: 'baseUrl', value: baseUrl, type: 'default', enabled: true },
      { key: 'region', value: env.region, type: 'default', enabled: true },
      { key: 'stage', value: env.stage, type: 'default', enabled: true },
      { key: 'apiId', value: env.apiId, type: 'default', enabled: true },
      { key: 'description', value: env.description || `${env.stage} environment in ${env.region}`, type: 'default', enabled: true }
    ];

    try {
      const existingUid = stateEntry.environments?.[env.name];
      const envUid = await upsertEnvironment(workspaceId, envName, envVars, apiKey, existingUid);
      createdEnvs[env.name] = envUid;
      console.log(`  ✓ ${envName} (${envUid})`);
    } catch (err) {
      console.error(`  ✗ Failed to create/update environment ${envName}: ${err.message}`);
    }
  }

  return createdEnvs;
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

    // Load environment configuration for multi-env support
    const envConfig = loadEnvironmentConfig();

    // read and transform openapi content for Postman compatibility
    const fileStat = fs.statSync(openapiPath);
    if (fileStat.size > 10 * 1024 * 1024) throw new Error('OpenAPI file exceeds 10 MB limit');
    const originalSpec = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
    let transformedSpec = transformSpecForPostman(originalSpec);
    
    // Enrich spec with multi-environment servers block if config exists
    if (envConfig) {
      transformedSpec = enrichSpecWithEnvironments(transformedSpec, service, envConfig);
    }
    
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

    // Resolve collection UID using multiple methods:
    // 1. State file (entry.collectionUid)
    // 2. Spec's generated collections (GET /specs/{specId}/collections)
    // 3. Name lookup (findCollectionByName)
    let collectionUid = entry.collectionUid || collectionUidArg;
    
    if (!collectionUid) {
      // Try to find collection via spec's generated collections
      const specCollections = await getSpecCollections(specId, POSTMAN_API_KEY);
      if (specCollections && specCollections.length > 0) {
        // Look for a collection matching our expected name
        const matchingCol = specCollections.find(c => c.name === collectionName);
        if (matchingCol?.uid) {
          collectionUid = matchingCol.uid;
          console.log(`Resolved Collection from spec's generated collections: ${collectionName} -> ${collectionUid}`);
        } else if (specCollections[0]?.uid) {
          // If only one collection exists for this spec, use it
          collectionUid = specCollections[0].uid;
          console.log(`Resolved Collection from spec (single collection): ${collectionUid}`);
        }
      }
    }
    
    if (!collectionUid) {
      // Fallback to name lookup
      const foundCol = await findCollectionByName(POSTMAN_WORKSPACE_ID, collectionName, POSTMAN_API_KEY);
      if (foundCol?.uid) {
        collectionUid = foundCol.uid;
        console.log(`Resolved Collection by name: ${collectionName} -> ${collectionUid}`);
      }
    }

    // Generate or sync collection
    if (collectionUid) {
      // Collection exists - sync it with the spec
      console.log(`Syncing collection ${collectionUid} with spec ${specId}...`);
      const { accepted, task } = await syncCollection(collectionUid, specId, POSTMAN_API_KEY);
      console.log(`Sync requested (202 expected): ${accepted}, task: ${JSON.stringify(task)}`);
      if (poll && task?.url) {
        console.log(`Polling sync task...`);
        const taskResult = await pollTask(task.url, POSTMAN_API_KEY);
        console.log(`Sync task completed: ${JSON.stringify(taskResult)}`);
        if (taskResult?.status !== 'success' && taskResult?.status !== 'completed') {
          const errorMsg = taskResult?.details || taskResult?.error?.message || 'Unknown error';
          throw new Error(`Collection sync failed: ${errorMsg}\nFull response: ${JSON.stringify(taskResult, null, 2)}`);
        }
      }
    } else {
      // Collection doesn't exist - generate it from the spec
      console.log(`No collection found. Generating collection "${collectionName}" from spec ${specId}...`);
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
      
      // Always poll generation tasks to get the collection UID
      console.log(`Polling generation task...`);
      const taskResult = await pollTask(task.url, POSTMAN_API_KEY);
      console.log(`Generation task completed: ${JSON.stringify(taskResult)}`);

      if (taskResult?.status !== 'success' && taskResult?.status !== 'completed') {
        const errorMsg = taskResult?.details || taskResult?.error?.message || 'Unknown error';
        throw new Error(`Collection generation failed: ${errorMsg}\nFull response: ${JSON.stringify(taskResult, null, 2)}`);
      }

      // Extract collection UID from task result
      // Task result structure: { details: { resources: [{ url: "/collections/{uid}", id: "{uid}" }] } }
      let generatedCollectionUid = null;
      
      // Try to extract from resources array in details
      if (taskResult?.details?.resources && Array.isArray(taskResult.details.resources)) {
        const resource = taskResult.details.resources.find(r => r.url?.includes('/collections/'));
        if (resource) {
          generatedCollectionUid = resource.id || resource.url?.split('/collections/')[1];
        }
      }
      
      // Fallback to other possible locations
      if (!generatedCollectionUid) {
        generatedCollectionUid = taskResult?.result?.collection?.uid || 
                                 taskResult?.collection?.uid || 
                                 taskResult?.result?.uid ||
                                 taskResult?.uid;
      }
      
      if (!generatedCollectionUid) {
        // If we can't get UID from task result, try to find the collection by name
        console.log(`Warning: Could not extract collection UID from task result. Looking up by name...`);
        const foundCollection = await findCollectionByName(POSTMAN_WORKSPACE_ID, collectionName, POSTMAN_API_KEY);
        if (foundCollection?.uid) {
          console.log(`Found collection by name: ${foundCollection.uid}`);
          generatedCollectionUid = foundCollection.uid;
        } else {
          throw new Error(`Failed to extract collection UID and collection not found by name. Task result: ${JSON.stringify(taskResult)}`);
        }
      }

      collectionUid = generatedCollectionUid;
      console.log(`Generated Collection: ${collectionName} (${collectionUid})`);
      console.log(`Collection is automatically linked to spec ${specId}`);
    }

    // Update state file with collection UID
    entry.collectionUid = collectionUid;
    if (!entry.specId) {
      entry.specId = specId;
    }

    // Create/update Postman environments from config
    if (envConfig) {
      console.log(''); // Blank line for readability
      const createdEnvs = await createEnvironmentsFromConfig(
        POSTMAN_WORKSPACE_ID,
        domain,
        service,
        envConfig,
        POSTMAN_API_KEY,
        entry
      );
      
      if (Object.keys(createdEnvs).length > 0) {
        entry.environments = { ...entry.environments, ...createdEnvs };
        console.log(`Created/updated ${Object.keys(createdEnvs).length} environments`);
      }
    }

    state.entries[entryKey] = entry;
    saveState(stateFile, state);
    console.log(`State file updated for ${entryKey}`);
  } catch (err) {
    console.error(err.stack || String(err));
    process.exit(1);
  }
})();

