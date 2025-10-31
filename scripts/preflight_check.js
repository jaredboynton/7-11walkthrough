#!/usr/bin/env node

// Configuration constants
// Set these directly or leave undefined to use environment variables
const POSTMAN_API_KEY = 'your-api-key'; // Set to your Postman API key, or leave undefined to use process.env.POSTMAN_API_KEY
const POSTMAN_WORKSPACE_ID = 'your-workspace-id'; // Set to your workspace ID, or leave undefined to use process.env.POSTMAN_WORKSPACE_ID

/*
Pre-flight validation script for 7-Eleven Postman OAS Ingestion workflow

Validates:
- Node.js version (v18+)
- AWS CLI availability and authentication
- Postman API key validity and permissions
- Required environment variables
- Scripts directory structure
- State directory initialization

Usage:
  node scripts/preflight_check.js

Configuration:
  Option 1: Set POSTMAN_API_KEY and POSTMAN_WORKSPACE_ID constants at top of this file
  Option 2: Set environment variables:
    export POSTMAN_API_KEY="your-api-key"
    export POSTMAN_WORKSPACE_ID="your-workspace-id"
*/

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const symbols = {
  pass: '✓',
  fail: '✗',
  warn: '⚠',
  info: 'ℹ',
};

class PreflightChecker {
  constructor() {
    this.checks = [];
    this.warnings = [];
    this.errors = [];
  }

  log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }

  logCheck(name, passed, message = '', suggestion = '') {
    const symbol = passed ? symbols.pass : symbols.fail;
    const color = passed ? 'green' : 'red';
    this.log(`${symbol} ${name}`, color);
    
    if (message) {
      this.log(`  ${message}`, passed ? 'cyan' : 'yellow');
    }
    
    if (!passed) {
      this.errors.push({ name, message, suggestion });
      if (suggestion) {
        this.log(`  → ${suggestion}`, 'yellow');
      }
    }
    
    this.checks.push({ name, passed, message, suggestion });
  }

  logWarning(name, message, suggestion = '') {
    this.log(`${symbols.warn} ${name}`, 'yellow');
    this.log(`  ${message}`, 'cyan');
    if (suggestion) {
      this.log(`  → ${suggestion}`, 'yellow');
    }
    this.warnings.push({ name, message, suggestion });
  }

  logInfo(message) {
    this.log(`${symbols.info} ${message}`, 'blue');
  }

  async checkNodeVersion() {
    try {
      const version = process.version;
      const major = parseInt(version.slice(1).split('.')[0], 10);
      const passed = major >= 18;
      
      this.logCheck(
        'Node.js version',
        passed,
        passed ? `${version} (sufficient)` : `${version} (need v18+)`,
        passed ? '' : 'Install Node.js v18+: nvm install 18 && nvm use 18'
      );
      
      return passed;
    } catch (error) {
      this.logCheck('Node.js version', false, 'Unable to determine version', 'Ensure Node.js is installed');
      return false;
    }
  }

  async checkAWSCLI() {
    try {
      // Check if AWS CLI is installed
      execSync('which aws', { stdio: 'pipe' });
      this.logCheck('AWS CLI installed', true, 'aws command found');
      
      // Check if AWS credentials are configured
      try {
        const identity = execSync('aws sts get-caller-identity --output json', { 
          stdio: 'pipe',
          encoding: 'utf-8'
        });
        
        const identityData = JSON.parse(identity);
        this.logCheck(
          'AWS credentials',
          true,
          `Authenticated as ${identityData.Arn}`
        );
        
        return true;
      } catch (credError) {
        this.logCheck(
          'AWS credentials',
          false,
          'Unable to authenticate with AWS',
          'Run: aws configure (or check AWS_PROFILE environment variable)'
        );
        return false;
      }
    } catch (error) {
      this.logCheck(
        'AWS CLI installed',
        false,
        'aws command not found',
        'Install AWS CLI: brew install awscli (macOS) or see https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'
      );
      return false;
    }
  }

  async checkPostmanAPIKey() {
    const apiKey = POSTMAN_API_KEY || process.env.POSTMAN_API_KEY;
    
    if (!apiKey) {
      this.logCheck(
        'POSTMAN_API_KEY',
        false,
        'Not set (constant or environment variable)',
        'Either set POSTMAN_API_KEY constant at top of script, or export: export POSTMAN_API_KEY="your-api-key"'
      );
      return false;
    }
    
    this.logCheck('POSTMAN_API_KEY', true, `Set (${apiKey.substring(0, 8)}...)`);
    
    // Validate key by calling Postman API
    try {
      const response = await fetch('https://api.getpostman.com/me', {
        headers: { 'X-Api-Key': apiKey }
      });
      
      if (response.ok) {
        const data = await response.json();
        this.logCheck(
          'Postman API authentication',
          true,
          `Authenticated as ${data.fullName || data.username || 'user'}`
        );
        return true;
      } else if (response.status === 401) {
        this.logCheck(
          'Postman API authentication',
          false,
          '401 Unauthorized - API key is invalid',
          'Regenerate API key in Postman Settings > API Keys'
        );
        return false;
      } else if (response.status === 403) {
        this.logCheck(
          'Postman API authentication',
          false,
          '403 Forbidden - API key lacks permissions',
          'Ensure API key has workspace write access'
        );
        return false;
      } else {
        this.logCheck(
          'Postman API authentication',
          false,
          `HTTP ${response.status}: ${response.statusText}`,
          'Check Postman API status or regenerate key'
        );
        return false;
      }
    } catch (error) {
      this.logCheck(
        'Postman API authentication',
        false,
        `Network error: ${error.message}`,
        'Check internet connectivity'
      );
      return false;
    }
  }

  async checkPostmanWorkspaceId() {
    const workspaceId = POSTMAN_WORKSPACE_ID || process.env.POSTMAN_WORKSPACE_ID;
    
    if (!workspaceId) {
      this.logCheck(
        'POSTMAN_WORKSPACE_ID',
        false,
        'Not set (constant or environment variable)',
        'Either set POSTMAN_WORKSPACE_ID constant at top of script, or export: export POSTMAN_WORKSPACE_ID="your-workspace-id"'
      );
      return false;
    }
    
    // Basic UUID validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isValidUUID = uuidRegex.test(workspaceId);
    
    if (!isValidUUID) {
      this.logWarning(
        'POSTMAN_WORKSPACE_ID format',
        'Does not appear to be a valid UUID',
        'Verify you copied the correct workspace ID from Postman'
      );
    }
    
    this.logCheck('POSTMAN_WORKSPACE_ID', true, workspaceId);
    return true;
  }

  async checkScripts() {
    const scriptsToCheck = [
      'scripts/spec_sync.js',
      'scripts/environments_upsert.js'
    ];
    
    let allExist = true;
    
    for (const script of scriptsToCheck) {
      const exists = fs.existsSync(script);
      this.logCheck(
        `Script: ${path.basename(script)}`,
        exists,
        exists ? 'Found' : 'Not found',
        exists ? '' : `Ensure ${script} exists in the project`
      );
      allExist = allExist && exists;
    }
    
    return allExist;
  }

  async checkStateDirectory() {
    const stateDir = 'state';
    const stateFile = 'state/postman-ingestion-state.json';
    
    // Check if state directory exists
    if (!fs.existsSync(stateDir)) {
      this.logWarning(
        'State directory',
        'state/ directory does not exist',
        'Will be created automatically on first run'
      );
      return true; // Not a blocker
    }
    
    this.logCheck('State directory', true, 'state/ exists');
    
    // Check if state file exists
    if (!fs.existsSync(stateFile)) {
      this.logWarning(
        'State file',
        'state/postman-ingestion-state.json does not exist',
        'Will be created automatically on first run'
      );
    } else {
      // Validate it's valid JSON
      try {
        const content = fs.readFileSync(stateFile, 'utf8');
        JSON.parse(content);
        this.logCheck('State file', true, 'Valid JSON');
      } catch (error) {
        this.logWarning(
          'State file',
          'state/postman-ingestion-state.json is not valid JSON',
          'Will be overwritten on next run'
        );
      }
    }
    
    return true;
  }

  async checkJQAvailability() {
    try {
      execSync('which jq', { stdio: 'pipe' });
      this.logCheck('jq (JSON processor)', true, 'Installed (helpful for debugging)');
    } catch (error) {
      this.logWarning(
        'jq (JSON processor)',
        'Not installed (optional but helpful)',
        'Install: brew install jq (macOS) or apt-get install jq (Linux)'
      );
    }
  }

  printSummary() {
    this.log('\n' + '='.repeat(60), 'cyan');
    this.log('PREFLIGHT CHECK SUMMARY', 'cyan');
    this.log('='.repeat(60), 'cyan');
    
    const passed = this.checks.filter(c => c.passed).length;
    const total = this.checks.length;
    const failed = total - passed;
    
    this.log(`\nTotal checks: ${total}`, 'blue');
    this.log(`Passed: ${passed}`, 'green');
    
    if (failed > 0) {
      this.log(`Failed: ${failed}`, 'red');
    }
    
    if (this.warnings.length > 0) {
      this.log(`Warnings: ${this.warnings.length}`, 'yellow');
    }
    
    if (this.errors.length > 0) {
      this.log('\n' + '='.repeat(60), 'red');
      this.log('ERRORS TO FIX:', 'red');
      this.log('='.repeat(60), 'red');
      this.errors.forEach((error, i) => {
        this.log(`\n${i + 1}. ${error.name}`, 'red');
        if (error.message) this.log(`   ${error.message}`, 'yellow');
        if (error.suggestion) this.log(`   → ${error.suggestion}`, 'cyan');
      });
    }
    
    if (this.warnings.length > 0 && this.errors.length === 0) {
      this.log('\n' + '='.repeat(60), 'yellow');
      this.log('WARNINGS (non-blocking):', 'yellow');
      this.log('='.repeat(60), 'yellow');
      this.warnings.forEach((warning, i) => {
        this.log(`\n${i + 1}. ${warning.name}`, 'yellow');
        if (warning.message) this.log(`   ${warning.message}`, 'cyan');
        if (warning.suggestion) this.log(`   → ${warning.suggestion}`, 'blue');
      });
    }
    
    this.log('\n' + '='.repeat(60), 'cyan');
    
    if (failed === 0) {
      this.log(`\n${symbols.pass} ALL CHECKS PASSED - Ready to proceed!`, 'green');
      return true;
    } else {
      this.log(`\n${symbols.fail} ${failed} check(s) failed - Fix errors before proceeding`, 'red');
      return false;
    }
  }

  async runAll() {
    this.log('\n' + '='.repeat(60), 'cyan');
    this.log('POSTMAN OAS INGESTION - PRE-FLIGHT CHECK', 'cyan');
    this.log('='.repeat(60) + '\n', 'cyan');
    
    this.logInfo('Validating environment for 7-Eleven session...\n');
    
    await this.checkNodeVersion();
    await this.checkAWSCLI();
    await this.checkPostmanAPIKey();
    await this.checkPostmanWorkspaceId();
    await this.checkScripts();
    await this.checkStateDirectory();
    await this.checkJQAvailability();
    
    const success = this.printSummary();
    
    process.exit(success ? 0 : 1);
  }
}

// Run if called directly
if (require.main === module) {
  const checker = new PreflightChecker();
  checker.runAll().catch(error => {
    console.error(`${colors.red}Fatal error during preflight check:${colors.reset}`);
    console.error(error);
    process.exit(1);
  });
}

module.exports = PreflightChecker;

