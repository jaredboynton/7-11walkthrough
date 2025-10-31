# 7-Eleven Follow-up Session: AWS API Gateway to Postman Spec Hub Integration

**Date**: October 31, 2025  
**Duration**: 60 minutes  
**Objective**: Complete the end-to-end workflow to sync AWS API Gateway specs with Postman using Node.js scripts, avoiding previous curl/authentication issues.

---

## Phase 1: Introduction & Goal Setting (0-5 minutes)

### Recap
In our last session on October 29, we successfully:
- Identified that 7-Eleven uses AWS API Gateway v2 (HTTP APIs) for Lambda-backed services
- Exported an OpenAPI spec from the basket API using AWS CLI
- Created a test workspace in Postman
- Generated a Postman API key

We encountered challenges with:
- Manual curl commands causing encoding errors
- 403 authentication errors when calling Postman API

### Today's Objective
"We will complete the end-to-end workflow using two Node.js scripts (`spec_sync.js` and `environments_upsert.js`) to sync your AWS API Gateway spec with Postman, generate a collection, and create a corresponding environment."

### What We'll Accomplish
1. Validate all prerequisites (AWS CLI, Postman API, Node.js)
2. Export OpenAPI spec from your basket API
3. Upload spec to Postman Spec Hub
4. Generate or sync a collection
5. Create a Postman environment with your API Gateway endpoint
6. Discuss automation via GitHub Actions

---

## Phase 2: Prerequisite Validation (5-15 minutes)

### Purpose
Confirm connectivity and credentials upfront to prevent common errors during the workflow.

### Step 2.0: Run Preflight Check (Automated Validation)

**Action**: Run the automated preflight validation script to check all prerequisites at once.

**Option 1: Using environment variables** (recommended for production/shared use):
```bash
# Navigate to project directory
cd /path/to/711-demo-walkthrough

# Set environment variables from .env file (if using dotenv) or export manually
export POSTMAN_API_KEY="your-postman-api-key-here"
export POSTMAN_WORKSPACE_ID="your-workspace-id-here"

# Run preflight check
node scripts/preflight_check.js
```

**Expected Output**: Colored status report showing:
- ✓ Node.js version (v18+)
- ✓ AWS CLI installed and authenticated
- ✓ Postman API key valid
- ✓ Postman workspace ID set
- ✓ Scripts available
- ✓ State directory initialized
- ✓ jq (optional but helpful)

**If preflight check passes**: Proceed directly to Phase 3 (Core Flow Execution).

**If preflight check fails**: Follow the remediation suggestions shown in the output for each failed check. The script provides specific guidance for fixing each issue (e.g., "Run: aws configure" or "Regenerate API key in Postman Settings > API Keys").

**Troubleshooting**:
- If script doesn't exist: Ensure you're in the project root directory
- If "Missing required env": Either export `POSTMAN_API_KEY` and `POSTMAN_WORKSPACE_ID` as environment variables, or use `preflight_check_local.js` which has credentials hardcoded
- Review error messages in the output - each check provides specific remediation steps
- All checks must pass before proceeding to Phase 3

**Note**: The preflight script validates all prerequisites automatically. Manual validation steps are no longer needed unless troubleshooting specific issues reported by the script.

---

## Phase 3: Core Flow Execution (15-35 minutes)

### Step 3.1: Export OpenAPI Spec from AWS API Gateway

**Action**: Export the spec from your basket API (HTTP API v2).

First, identify your API ID and stage:
```bash
# List all HTTP APIs
aws apigatewayv2 get-apis

# List stages for a specific API
aws apigatewayv2 get-stages --api-id <YOUR_API_ID>
```

**From last session**: Your basket API ID was similar to `mp4fxy1oj` (confirm actual ID).

Export the spec:
```bash
aws apigatewayv2 export-api \
  --api-id <YOUR_API_ID> \
  --output-type JSON \
  --specification OAS30 \
  --stage-name <YOUR_STAGE> \
  openapi.json
```

**Example with actual values**:
```bash
aws apigatewayv2 export-api \
  --api-id mp4fxy1oj \
  --output-type JSON \
  --specification OAS30 \
  --stage-name dev \
  openapi.json
```

**Validation**: Check the exported file contains valid JSON:
```bash
# View first few lines
head -20 openapi.json

# Validate it's proper JSON
cat openapi.json | jq . > /dev/null && echo "Valid JSON" || echo "Invalid JSON"
```

**Expected**: File should contain `"openapi": "3.0.1"` or similar near the top.

**Troubleshooting**:
- If "NotFoundException": Wrong API ID - double-check with `get-apis` command
- If "Invalid stage identifier": Use exact stage name from `get-stages` output
- If using REST API v1 instead: Use `aws apigateway get-export --rest-api-id ... --stage-name ... --export-type oas30 openapi.json`

### Step 3.2: Run spec_sync.js to Upload to Postman Spec Hub

**Action**: Use the Node.js script to create/update the spec in Postman and sync the collection.

**Script Usage**:
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

**For 7-Eleven basket API**:
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

**What This Does**:
1. Reads the OpenAPI spec from `openapi.json`
2. Creates or resolves a Spec in Postman with name: `[retail] basket #api`
3. Uploads/updates the spec content
4. Looks for a collection named: `[retail] basket #reference-dev`
5. If collection exists, syncs it with the updated spec
6. If collection doesn't exist, prints instructions to generate it manually
7. Saves state to `state/postman-ingestion-state.json` for future runs

**Expected Output**:
```
Resolved Spec by name: [retail] basket #api -> spec-abc123
Patched spec file index.json
No collection UID resolved. Generate a collection from the Spec (once) in Postman, then rerun to sync.
Expected collection name: [retail] basket #reference-dev
```

**If collection doesn't exist yet** (first run):
- The script will upload the spec successfully but can't sync a collection that doesn't exist yet
- We'll generate the collection in the Postman UI next

**If collection already exists** (subsequent runs):
```
Resolved Spec by name: [retail] basket #api -> spec-abc123
Patched spec file index.json
Resolved Collection by name: [retail] basket #reference-dev -> col-xyz789
Sync requested (202 expected): true, task: {"taskId":"...","url":"/specs/spec-abc123/tasks/..."}
Sync task completed: {"status":"success"}
```

**Troubleshooting**:
- If "Missing required env: POSTMAN_API_KEY": Re-export the environment variable
- If "OpenAPI file exceeds 10 MB limit": Spec is too large - may need to split it
- If "Postman API POST /specs failed: 400": Invalid spec format - validate with `jq . openapi.json`
- If "403 Forbidden": API key lacks workspace write permissions - regenerate with correct scope
- If script hangs on --poll: Sync task may be taking longer than expected - safe to Ctrl+C and check Postman UI

### Step 3.3: Generate Collection in Postman UI (First Time Only)

**Action**: If this is the first time syncing this API, generate a collection from the spec in Postman.

**Steps**:
1. Open Postman workspace in browser
2. Navigate to "APIs" in left sidebar
3. Find the spec: `[retail] basket #api`
4. Click on the spec to open it
5. Click the "Collections" tab
6. Click "Generate Collection" button
7. Name the collection: `[retail] basket #reference-dev`
8. Click "Generate Collection"

**Validation**: You should now see the collection in your workspace with all endpoints from the spec.

**Re-run sync script**: Now that the collection exists, re-run the spec_sync.js command:
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

This time it should find the collection and sync it.

---

## Phase 4: Environment Creation and UI Validation (35-50 minutes)

### Step 4.1: Create Postman Environment

**Action**: Use the environments_upsert.js script to create a Postman environment with your API Gateway URL.

**Script Usage**:
```bash
node scripts/environments_upsert.js \
  --domain <domain> \
  --service <service> \
  --stage <stage> \
  --region <region> \
  --openapi openapi.json
```

**For 7-Eleven basket API**:
```bash
node scripts/environments_upsert.js \
  --domain retail \
  --service basket \
  --stage dev \
  --region us-east-1 \
  --openapi openapi.json
```

**What This Does**:
1. Reads the API Gateway base URL from `openapi.json` (from `servers[0].url`)
2. Creates or updates an environment named: `[retail] basket #env-us-east-1-dev`
3. Sets variables:
   - `baseUrl`: Your API Gateway invoke URL
   - `stage`: `dev`
   - `region`: `us-east-1`
   - `apiKey`: (empty placeholder)
   - `bearerToken`: (empty placeholder)

**Expected Output**:
```
Created environment [retail] basket #env-us-east-1-dev (env-abc123)
```
or
```
Updated environment [retail] basket #env-us-east-1-dev (env-abc123)
```

**Troubleshooting**:
- If "Warning: baseUrl was not set": The OpenAPI spec doesn't have `servers[0].url` - use explicit `--base-url` flag:
  ```bash
  node scripts/environments_upsert.js \
    --domain retail --service basket --stage dev --region us-east-1 \
    --base-url "https://<YOUR_API_ID>.execute-api.us-east-1.amazonaws.com/dev"
  ```
- If "403 Forbidden": API key issue - regenerate and re-export
- If environment created but `baseUrl` is wrong: Re-run with `--base-url` override

### Step 4.2: Validate in Postman UI

**Action**: Confirm everything is set up correctly in Postman.

#### Validate Spec in Spec Hub
1. Open Postman workspace
2. Go to "APIs" in left sidebar
3. Click on `[retail] basket #api`
4. Verify:
   - "Last updated" timestamp is recent
   - "Define" tab shows your OpenAPI spec content
   - Endpoints and schemas are visible

#### Validate Collection
1. Go to "Collections" in left sidebar
2. Find `[retail] basket #reference-dev`
3. Expand the collection
4. Verify:
   - All API endpoints are present (GET, POST, etc.)
   - Request structure matches your API
   - Collection has a link icon indicating it's linked to the spec

#### Validate Environment
1. Go to "Environments" in left sidebar
2. Find `[retail] basket #env-us-east-1-dev`
3. Click to view variables
4. Verify:
   - `baseUrl` contains your API Gateway URL (e.g., `https://mp4fxy1oj.execute-api.us-east-1.amazonaws.com/dev`)
   - `stage` is set to `dev`
   - `region` is set to `us-east-1`
   - Placeholders for `apiKey` and `bearerToken` exist

#### Test a Request (Optional)
1. Select the environment in the top-right dropdown
2. Open a request from the collection
3. Replace any hardcoded URLs with `{{baseUrl}}`
4. Click "Send" to test connectivity to your API Gateway

---

## Phase 5: Next Steps & Automation Discussion (50-60 minutes)

### Recap: What We Accomplished
- AWS Export → Postman Spec Hub → Collection Generation → Environment Creation
- All using Node.js scripts for reliability and repeatability
- State is maintained in `state/postman-ingestion-state.json` for idempotency

### The Automation Path

#### Current State (Manual)
What we did today was manual but scripted. For each API update:
1. Export spec from AWS
2. Run `spec_sync.js`
3. Run `environments_upsert.js`

#### Target State (Automated via CI/CD)

**Trigger**: After successful deployment to AWS (e.g., via GitHub Actions, Jenkins, GitLab CI)

**Pipeline Steps**:
```yaml
- name: Export OpenAPI from API Gateway
  run: |
    aws apigatewayv2 export-api \
      --api-id ${{ secrets.API_ID }} \
      --output-type JSON \
      --specification OAS30 \
      --stage-name ${{ github.event.inputs.stage }} \
      openapi.json

- name: Sync to Postman Spec Hub
  env:
    POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
    POSTMAN_WORKSPACE_ID: ${{ secrets.POSTMAN_WORKSPACE_ID }}
  run: |
    node scripts/spec_sync.js \
      --domain retail \
      --service basket \
      --stage ${{ github.event.inputs.stage }} \
      --openapi openapi.json \
      --file-path index.json \
      --state-file state/postman-ingestion-state.json \
      --poll

- name: Upsert Postman Environment
  env:
    POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
    POSTMAN_WORKSPACE_ID: ${{ secrets.POSTMAN_WORKSPACE_ID }}
  run: |
    node scripts/environments_upsert.js \
      --domain retail --service basket \
      --stage ${{ github.event.inputs.stage }} \
      --region us-east-1 \
      --openapi openapi.json
```

**Key Requirements for Automation**:

1. **Secrets Management**:
   - Store `POSTMAN_API_KEY` in GitHub Secrets (or equivalent)
   - Store `POSTMAN_WORKSPACE_ID` in GitHub Secrets
   - Use AWS OIDC for AWS authentication (no long-lived keys)

2. **IAM Permissions** (for GitHub Actions):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "apigatewayv2:GetApis",
           "apigatewayv2:GetStages",
           "apigatewayv2:ExportApi"
         ],
         "Resource": "*"
       }
     ]
   }
   ```

3. **State File**: 
   - Option A: Commit `state/postman-ingestion-state.json` to repo for versioning
   - Option B: Store in S3 bucket and download/upload in pipeline

4. **Multiple APIs**: 
   - Use matrix strategy in GitHub Actions to process multiple APIs in parallel
   - Or use the bulk ingestion approach from the proposal

### Immediate Next Steps

1. **Document your basket API parameters**:
   - API ID: `mp4fxy1oj` (or actual ID)
   - Stage names: `dev`, `qa`, `prod`
   - Region: `us-east-1`
   - Domain: `retail`
   - Service: `basket`

2. **Test with another API**: 
   - Pick a second API (e.g., shopping cart)
   - Run through the same workflow to validate repeatability

3. **Set up GitHub Actions workflow**:
   - Use the template in `POSTMAN_OAS_INGESTION_PROPOSAL.md`
   - Start with manual dispatch for testing
   - Add to deployment pipeline once validated

4. **Bulk ingestion** (when ready):
   - Use the inventory approach from the proposal
   - Script to iterate through all APIs/stages
   - Tag APIs in AWS with `postman:managed=true` for filtering

### Additional Considerations

**Collection Testing with Newman**:
- Once collections are in Postman, you can run them via Newman CLI for automated testing
- Example: `newman run collection.json -e environment.json`

**Postman CLI for Validation**:
- Validate OpenAPI specs before ingestion: `postman openapi validate openapi.json`
- Catch issues early in the pipeline

**Monitoring**:
- Add notifications on pipeline failures (Slack, email)
- Log sync task IDs for troubleshooting
- Track which specs/collections were updated

---

## Troubleshooting Guide

### Problem: "Postman API returned 403 Forbidden"
**Cause**: API key lacks necessary permissions or is invalid.  
**Solution**: 
1. Go to Postman Settings > API Keys
2. Delete the current key
3. Generate a new one ensuring it has workspace write access
4. Update environment variable: `export POSTMAN_API_KEY="new-key"`

### Problem: "aws: command not found"
**Cause**: AWS CLI not installed or not in PATH.  
**Solution**: Install AWS CLI v2: `brew install awscli` (macOS) or follow [AWS docs](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)

### Problem: "node: command not found"
**Cause**: Node.js not installed.  
**Solution**: Install via nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash && nvm install 18`

### Problem: Scripts run but collection doesn't sync
**Cause**: Collection was manually created with different name, or not generated from spec.  
**Solution**: 
1. Ensure collection was generated from the spec in Postman (not manually created)
2. Verify collection name exactly matches: `[<domain>] <service> #reference-<stage>`
3. Check the link icon on collection - should show it's linked to the spec

### Problem: "OpenAPI file exceeds 10 MB limit"
**Cause**: Spec file is too large for Postman API.  
**Solution**: 
1. Check file size: `ls -lh openapi.json`
2. Consider splitting into multiple specs
3. Remove unnecessary examples/descriptions if possible

### Problem: Environment created but baseUrl is missing
**Cause**: OpenAPI spec doesn't include `servers[0].url`.  
**Solution**: Use explicit `--base-url` flag:
```bash
node scripts/environments_upsert.js \
  --domain retail --service basket --stage dev \
  --base-url "https://your-api-id.execute-api.region.amazonaws.com/stage"
```

---

## Reference Links

- [Postman Spec Hub API Docs](https://www.postman.com/postman/workspace/postman-public-workspace/documentation/12959542-c8142d51-e97c-46b6-bd77-52bb66712c9a)
- [AWS API Gateway v2 Export API](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/apis-apiid.html#ExportApi)
- [OpenAPI 3.0 Specification](https://spec.openapis.org/oas/v3.0.0)
- [GitHub Actions OIDC with AWS](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)

---

## Session Checklist

Pre-session:
- [ ] AWS CLI configured and authenticated
- [ ] Postman API key generated
- [ ] Node.js v18+ installed
- [ ] Scripts directory available
- [ ] Test workspace created in Postman

During session:
- [ ] Validated AWS credentials
- [ ] Validated Postman API key
- [ ] Exported OpenAPI spec from API Gateway
- [ ] Uploaded spec to Postman Spec Hub
- [ ] Generated collection from spec
- [ ] Synced collection with spec
- [ ] Created Postman environment
- [ ] Validated all assets in Postman UI

Post-session:
- [ ] Document API parameters (ID, stage, region)
- [ ] Revoke and regenerate Postman API key
- [ ] Plan GitHub Actions automation
- [ ] Identify next APIs to onboard

