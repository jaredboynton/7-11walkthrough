# Automated OAS Ingestion for Postman via AWS API Gateway

Automated workflow to sync OpenAPI specifications from AWS API Gateway to Postman Spec Hub, generating collections and environments for API testing and documentation.

## Quick Start

### Prerequisites
1. Node.js v18+ installed
2. AWS CLI configured with valid credentials
3. Postman API key with workspace write access
4. Postman workspace ID

### Run Preflight Check
```bash
export POSTMAN_API_KEY="your-api-key"
export POSTMAN_WORKSPACE_ID="your-workspace-id"

node scripts/preflight_check.js
```

### Basic Workflow
```bash
# 1. Export OpenAPI spec from API Gateway
aws apigatewayv2 export-api \
  --api-id <API_ID> \
  --output-type JSON \
  --specification OAS30 \
  --stage-name <STAGE> \
  openapi.json

# 2. Sync to Postman Spec Hub
node scripts/spec_sync.js \
  --domain <domain> \
  --service <service> \
  --stage <stage> \
  --openapi openapi.json \
  --state-file state/postman-ingestion-state.json \
  --poll

# 3. Create Postman environment
node scripts/environments_upsert.js \
  --domain <domain> \
  --service <service> \
  --stage <stage> \
  --region <region> \
  --openapi openapi.json
```

## Documentation

### For Today's Session
- **[session_walkthrough.md](./session_walkthrough.md)** - Complete 60-minute walkthrough for 7-Eleven follow-up session
- **[quick_reference.md](./quick_reference.md)** - One-page cheat sheet with all commands and troubleshooting

### Planning & Architecture
- **[POSTMAN_OAS_INGESTION_PROPOSAL.md](./POSTMAN_OAS_INGESTION_PROPOSAL.md)** - Full automation proposal and architecture
- **[manual_validation.md](./manual_validation.md)** - POC steps with lessons learned from 7-Eleven session

### Scripts
- **[scripts/spec_sync.js](./scripts/spec_sync.js)** - Syncs OpenAPI specs to Postman Spec Hub and collections
- **[scripts/environments_upsert.js](./scripts/environments_upsert.js)** - Creates/updates Postman environments
- **[scripts/preflight_check.js](./scripts/preflight_check.js)** - Validates prerequisites before running workflow

## Project Structure

```
.
├── README.md                              # This file
├── POSTMAN_OAS_INGESTION_PROPOSAL.md     # Full proposal and architecture
├── session_walkthrough.md                 # Today's 60-minute session guide
├── quick_reference.md                     # Command cheat sheet
├── manual_validation.md                   # POC steps with lessons learned
├── first_711_workingsession.md            # Transcript from Oct 29 session
├── scripts/
│   ├── spec_sync.js                       # Spec Hub sync script
│   ├── environments_upsert.js             # Environment management script
│   └── preflight_check.js                 # Pre-session validation
└── state/
    ├── README.md                          # State file documentation
    └── postman-ingestion-state.json       # State tracking for idempotency
```

## Key Features

### Idempotent Operations
- State file tracks spec and collection IDs
- Subsequent runs update existing assets instead of creating duplicates
- Handles resolve-by-name when IDs aren't cached

### Naming Conventions
- **Spec**: `[<domain>] <service> #api`
- **Collection**: `[<domain>] <service> #reference-<stage>`
- **Environment**: `[<domain>] <service> #env-<region>-<stage>`

### Async Sync with Polling
- Collection sync is asynchronous (returns 202 Accepted)
- `--poll` flag waits for sync task completion
- Validates sync succeeded before proceeding

## Lessons Learned (7-Eleven Session - Oct 29, 2025)

### What Worked
- AWS API Gateway v2 (HTTP API) export via AWS CLI
- Postman workspace creation and API key generation
- Identifying correct API Gateway types

### Challenges
- Manual curl commands caused encoding and 403 authentication errors
- JSON escaping complexity in shell scripts
- API Gateway type confusion (REST v1 vs HTTP v2)

### Resolution
**Use the Node.js helper scripts** - They handle JSON serialization, authentication, error handling, and state management automatically.

## Automation Path

### Current State (Manual but Scripted)
Today's workflow is manual but uses scripts for reliability. Each API update requires:
1. Export spec from AWS
2. Run `spec_sync.js`
3. Run `environments_upsert.js`

### Target State (CI/CD Automation)
**GitHub Actions** workflow triggered after AWS deployments:
- Exports specs automatically
- Syncs to Postman
- Updates environments
- Posts links to specs/collections in deployment notifications

See [POSTMAN_OAS_INGESTION_PROPOSAL.md](./POSTMAN_OAS_INGESTION_PROPOSAL.md) for complete automation architecture.

## Troubleshooting

### Quick Fixes

| Problem | Solution |
|---------|----------|
| `403 Forbidden` (Postman) | Regenerate API key with workspace write access |
| `aws: command not found` | Install AWS CLI: `brew install awscli` |
| `node: command not found` | Install Node.js v18+: `nvm install 18` |
| Collection not syncing | Generate collection in Postman UI from spec first |

See [quick_reference.md](./quick_reference.md) for complete troubleshooting matrix.

## Support & Resources

- [Postman API Documentation](https://www.postman.com/postman/workspace/postman-public-workspace/documentation/12959542-c8142d51-e97c-46b6-bd77-52bb66712c9a)
- [AWS API Gateway v2 API Reference](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/)
- [OpenAPI 3.0 Specification](https://spec.openapis.org/oas/v3.0.0)

## Next Steps

1. **Today's session**: Follow [session_walkthrough.md](./session_walkthrough.md)
2. **Test with additional APIs**: Validate repeatability
3. **Set up GitHub Actions**: Automate for continuous sync
4. **Bulk ingestion**: Use inventory approach for all APIs

---

**Last Updated**: October 31, 2025  
**Session Date**: October 31, 2025 (Follow-up from Oct 29)  
**Customer**: 7-Eleven Inc.

