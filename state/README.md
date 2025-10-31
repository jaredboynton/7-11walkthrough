# State Directory

This directory contains the state file used by the Postman OAS ingestion scripts to maintain idempotency across runs.

## Files

### `postman-ingestion-state.json`

Tracks the mapping between AWS API Gateway resources and Postman assets.

**Structure**:
```json
{
  "entries": {
    "<domain>:<service>:<stage>": {
      "specId": "postman-spec-id",
      "collectionUid": "postman-collection-uid",
      "lastSpecSha": "sha256-hash-of-spec-content"
    }
  },
  "meta": {
    "description": "State file for Postman OAS ingestion workflow",
    "version": "1.0",
    "lastUpdated": "ISO 8601 timestamp",
    "note": "Automatically maintained by spec_sync.js"
  }
}
```

**Purpose**:
- Enables idempotent operations: scripts can resolve existing specs and collections by name or use cached IDs
- Tracks spec content hashes to avoid unnecessary updates
- Maintains stable references across pipeline runs

**Management**:
- Automatically created on first run if it doesn't exist
- Updated after each successful spec/collection operation
- Can be committed to version control or stored in S3 for shared CI/CD environments

## Usage

The state file is referenced via the `--state-file` flag in `spec_sync.js`:

```bash
node scripts/spec_sync.js \
  --domain retail \
  --service basket \
  --stage dev \
  --openapi openapi.json \
  --state-file state/postman-ingestion-state.json \
  --poll
```

## Version Control

**Option A: Commit to Git** (recommended for single-user or simple workflows)
- Advantages: Simple, version history visible
- Disadvantages: May cause merge conflicts in multi-user scenarios

**Option B: Store in S3** (recommended for CI/CD pipelines)
- Download from S3 before pipeline runs
- Upload to S3 after successful operations
- Prevents conflicts, shared across all pipeline runs

Example S3 workflow:
```bash
# Download state
aws s3 cp s3://your-bucket/postman-state.json state/postman-ingestion-state.json

# Run sync
node scripts/spec_sync.js ...

# Upload updated state
aws s3 cp state/postman-ingestion-state.json s3://your-bucket/postman-state.json
```

