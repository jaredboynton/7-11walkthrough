# Quick Reference: Postman OAS Ingestion

## Pre-Session Setup

### 1. Export Environment Variables
```bash
export POSTMAN_API_KEY="your-postman-api-key"
export POSTMAN_WORKSPACE_ID="your-workspace-id"
```

### 2. Run Preflight Check
```bash
node scripts/preflight_check.js
```

---

## AWS API Gateway Export

### HTTP API (v2) - Most Common
```bash
aws apigatewayv2 export-api \
  --api-id <API_ID> \
  --output-type JSON \
  --specification OAS30 \
  --stage-name <STAGE> \
  openapi.json
```

### REST API (v1)
```bash
aws apigateway get-export \
  --rest-api-id <REST_API_ID> \
  --stage-name <STAGE> \
  --export-type oas30 \
  --parameters extensions='postman' \
  --accepts application/json \
  openapi.json
```

### List APIs and Stages
```bash
# List HTTP APIs
aws apigatewayv2 get-apis

# List stages for HTTP API
aws apigatewayv2 get-stages --api-id <API_ID>

# List REST APIs
aws apigateway get-rest-apis

# List stages for REST API
aws apigateway get-stages --rest-api-id <REST_API_ID>
```

---

## Spec Sync to Postman

### Basic Usage
```bash
node scripts/spec_sync.js \
  --domain <domain> \
  --service <service> \
  --stage <stage> \
  --openapi openapi.json \
  --file-path index.json \
  --state-file state/postman-ingestion-state.json \
  --poll
```

### Example (7-Eleven basket API)
```bash
node scripts/spec_sync.js \
  --domain retail \
  --service basket \
  --stage dev \
  --openapi openapi.json \
  --file-path index.json \
  --state-file state/postman-ingestion-state.json \
  --poll
```

### All Available Flags
| Flag | Required | Description |
|------|----------|-------------|
| `--domain` | Yes | Domain name (e.g., retail, billing) |
| `--service` | Yes | Service name (e.g., basket, payments) |
| `--stage` | Yes | Stage name (e.g., dev, prod) |
| `--openapi` | Yes | Path to OpenAPI spec file |
| `--file-path` | No | Spec file path in Postman (default: index.json) |
| `--spec-id` | No | Existing spec ID (skips lookup) |
| `--collection-uid` | No | Existing collection UID (skips lookup) |
| `--state-file` | No | State file path (default: state/postman-ingestion-state.json) |
| `--poll` | No | Poll sync task until completion |

### Naming Convention
- **Spec**: `[<domain>] <service> #api`
- **Collection**: `[<domain>] <service> #reference-<stage>`

---

## Environment Creation

### Basic Usage
```bash
node scripts/environments_upsert.js \
  --domain <domain> \
  --service <service> \
  --stage <stage> \
  --region <region> \
  --openapi openapi.json
```

### Example (7-Eleven basket API)
```bash
node scripts/environments_upsert.js \
  --domain retail \
  --service basket \
  --stage dev \
  --region us-east-1 \
  --openapi openapi.json
```

### With Explicit Base URL
```bash
node scripts/environments_upsert.js \
  --domain retail \
  --service basket \
  --stage dev \
  --region us-east-1 \
  --base-url "https://abc123.execute-api.us-east-1.amazonaws.com/dev"
```

### All Available Flags
| Flag | Required | Description |
|------|----------|-------------|
| `--domain` | Yes | Domain name |
| `--service` | Yes | Service name |
| `--stage` | Yes | Stage name |
| `--region` | No | AWS region (included in env name) |
| `--openapi` | No | OpenAPI file to extract baseUrl from |
| `--base-url` | No | Override baseUrl (bypasses OpenAPI extraction) |
| `--env-uid` | No | Existing environment UID (skips lookup) |

### Naming Convention
- **Environment**: `[<domain>] <service> #env-<region>-<stage>`
- **Environment (no region)**: `[<domain>] <service> #env-<stage>`

---

## Validation Commands

### Check Exported Spec
```bash
# View first 20 lines
head -20 openapi.json

# Validate JSON syntax
cat openapi.json | jq . > /dev/null && echo "Valid" || echo "Invalid"

# Pretty print with jq
cat openapi.json | jq .
```

### Verify AWS Credentials
```bash
aws sts get-caller-identity
```

### Test Postman API Key
```bash
curl --location 'https://api.getpostman.com/me' \
  --header "X-Api-Key: $POSTMAN_API_KEY"
```

---

## Troubleshooting Matrix

| Symptom | Cause | Solution |
|---------|-------|----------|
| `403 Forbidden` (Postman API) | Invalid or insufficient API key permissions | Regenerate API key in Postman Settings > API Keys with workspace write access |
| `401 Unauthorized` (Postman API) | Expired or revoked API key | Generate new API key and update `$POSTMAN_API_KEY` |
| `NotFoundException` (AWS) | Wrong API ID or stage name | Verify with `aws apigatewayv2 get-apis` and `get-stages` |
| `aws: command not found` | AWS CLI not installed | Install: `brew install awscli` (macOS) or see [AWS docs](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| `node: command not found` | Node.js not installed | Install: `nvm install 18 && nvm use 18` |
| "Missing required env" error | Environment variable not set | `export POSTMAN_API_KEY="..." && export POSTMAN_WORKSPACE_ID="..."` |
| "OpenAPI file exceeds 10 MB" | Spec file too large | Split spec or remove unnecessary examples |
| Collection not syncing | Collection not generated from spec | Generate collection in Postman UI from the spec first |
| Invalid JSON error | Malformed OpenAPI spec | Validate with `jq . openapi.json` |
| baseUrl missing in environment | OpenAPI spec has no `servers[0].url` | Use `--base-url` flag explicitly |
| Script hangs on `--poll` | Sync task taking longer than expected | Safe to Ctrl+C and check Postman UI manually |

---

## Postman UI Validation

### After Spec Sync
1. Go to **APIs** in left sidebar
2. Find `[<domain>] <service> #api`
3. Verify "Last updated" timestamp is recent
4. Check "Define" tab shows spec content

### After Collection Generation/Sync
1. Go to **Collections** in left sidebar
2. Find `[<domain>] <service> #reference-<stage>`
3. Verify endpoints are present
4. Check for link icon (indicates linked to spec)

### After Environment Creation
1. Go to **Environments** in left sidebar
2. Find `[<domain>] <service> #env-<region>-<stage>`
3. Verify variables: `baseUrl`, `stage`, `region`, `apiKey`, `bearerToken`
4. Select environment in top-right dropdown to use it

---

## GitHub Actions Integration

### Minimal Workflow Example
```yaml
name: Sync to Postman
on:
  workflow_dispatch:
    inputs:
      api_id:
        required: true
      stage:
        required: true
      
jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: us-east-1
      
      - name: Export OpenAPI
        run: |
          aws apigatewayv2 export-api \
            --api-id ${{ inputs.api_id }} \
            --output-type JSON \
            --specification OAS30 \
            --stage-name ${{ inputs.stage }} \
            openapi.json
      
      - name: Sync to Postman
        env:
          POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
          POSTMAN_WORKSPACE_ID: ${{ secrets.POSTMAN_WORKSPACE_ID }}
        run: |
          node scripts/spec_sync.js \
            --domain retail \
            --service basket \
            --stage ${{ inputs.stage }} \
            --openapi openapi.json \
            --state-file state/postman-ingestion-state.json \
            --poll
```

### Required Secrets
- `POSTMAN_API_KEY`: Postman API key with workspace write access
- `POSTMAN_WORKSPACE_ID`: Target workspace UUID
- `AWS_ROLE_ARN`: IAM role ARN for OIDC authentication (recommended over access keys)

---

## Useful Links

- [Full Walkthrough](./session_walkthrough.md) - Detailed 60-minute session guide
- [Proposal Document](./POSTMAN_OAS_INGESTION_PROPOSAL.md) - Complete automation proposal
- [Postman API Docs](https://www.postman.com/postman/workspace/postman-public-workspace/documentation/12959542-c8142d51-e97c-46b6-bd77-52bb66712c9a) - Spec Hub API reference
- [AWS API Gateway v2 API](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/) - Export API documentation
- [OpenAPI 3.0 Spec](https://spec.openapis.org/oas/v3.0.0) - OpenAPI specification

---

## Quick Checklist

Pre-session:
- [ ] `aws sts get-caller-identity` succeeds
- [ ] `curl https://api.getpostman.com/me -H "X-Api-Key: $POSTMAN_API_KEY"` returns user info
- [ ] `node -v` shows v18 or higher
- [ ] `node scripts/preflight_check.js` passes all checks

During session:
- [ ] Export OpenAPI spec from API Gateway
- [ ] Validate JSON with `jq . openapi.json`
- [ ] Run `spec_sync.js` to upload spec
- [ ] Generate collection in Postman UI (first time only)
- [ ] Run `spec_sync.js` again to sync collection
- [ ] Run `environments_upsert.js` to create environment
- [ ] Verify all assets in Postman UI

Post-session:
- [ ] Revoke and regenerate Postman API key
- [ ] Document API parameters (ID, stage, region)
- [ ] Plan GitHub Actions automation

