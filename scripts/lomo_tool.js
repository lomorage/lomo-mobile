#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Try loading argon2 and bonjour-service dynamically and report clean instructions if missing
let argon2;
try {
  argon2 = require('argon2');
} catch (e) {
  console.error("Error: 'argon2' module not found. Please install dependencies first:\n  npm install argon2 bonjour-service --no-save\n");
  process.exit(1);
}

let Bonjour;
try {
  Bonjour = require('bonjour-service').Bonjour;
} catch (e) {
  console.error("Error: 'bonjour-service' module not found. Please install dependencies first:\n  npm install argon2 bonjour-service --no-save\n");
  process.exit(1);
}

const SALT_POSTFIX = '@lomorage.lomoware';

// Helper to parse arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const parsed = { command, options: {} };
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        parsed.options[key] = val;
        i++;
      } else {
        parsed.options[key] = true;
      }
    }
  }
  return parsed;
}

// 1. Discover Services
function discoverServices(timeout = 5000) {
  console.log(`Scanning for Lomorage services (_lomod._tcp.local.) for ${timeout / 1000} seconds...`);
  const bonjour = new Bonjour();
  const services = [];

  const browser = bonjour.find({ type: 'lomod' });
  browser.on('up', (service) => {
    services.push(service);
    console.log(`+ Found: ${service.name} (${service.addresses.join(', ')}:${service.port})`);
  });

  setTimeout(() => {
    browser.stop();
    bonjour.destroy();
    console.log('\nScan completed.');
    if (services.length === 0) {
      console.log('No Lomorage services discovered.');
    }
  }, timeout);
}

// 2. Hash Password
async function hashPassword(username, password) {
  const salt = Buffer.from(username + SALT_POSTFIX);
  
  // Hash secret with Argon2id matching client parameters
  const encodedHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 4096,
    timeCost: 3,
    parallelism: 1,
    salt: salt,
    hashLength: 32,
    raw: false
  });
  
  // The server expects hex-encoded version of full Argon2 encoded string with null-terminator
  const hexHash = Buffer.from(encodedHash).toString('hex') + '00';
  return hexHash;
}

// 3. Login
async function login(url, username, password, deviceId = 'js-lomo-tool') {
  let serverUrl = url.startsWith('http') ? url : `http://${url}`;
  
  try {
    console.log(`Hashing password with Argon2id for user: ${username}...`);
    const hashedPassword = await hashPassword(username, password);
    
    const credentials = `${username}:${hashedPassword}:${deviceId}`;
    const base64Credentials = Buffer.from(credentials).toString('base64');
    
    console.log(`Connecting to Lomorage server at ${serverUrl}/login...`);
    const response = await axios.get(`${serverUrl}/login`, {
      headers: {
        Authorization: `Basic ${base64Credentials}`
      }
    });

    if (response.status === 200 && response.data && response.data.Token) {
      console.log('Login successful!');
      console.log(`User ID: ${response.data.Userid}`);
      console.log(`Token: ${response.data.Token}`);
      return response.data.Token;
    } else {
      console.log(`Login failed: ${response.status} - ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    console.error(`Error during login: ${error.message}`);
  }
}

// 4. Fetch Metadata
async function fetchMetadata(url, token, assetHash) {
  let serverUrl = url.startsWith('http') ? url : `http://${url}`;
  
  console.log(`Fetching metadata for asset hash ${assetHash}...`);
  try {
    const response = await axios.get(`${serverUrl}/asset/metadata/${assetHash}`, {
      headers: {
        Authorization: `token=${token}`
      }
    });

    if (response.status === 200 && response.data && response.data.Metadatas) {
      console.log(`\nMetadata for ${assetHash}:`);
      console.log('='.repeat(60));
      for (const meta of response.data.Metadatas) {
        let displayValue = meta.Value;
        if (meta.Name === 'shared.similarity.clip.embedding' || meta.Name.endsWith('.similarity.clip.embedding')) {
          if (displayValue.length > 40) {
            displayValue = displayValue.slice(0, 40) + `... [Length: ${meta.Value.length} chars]`;
          }
        }
        console.log(`Name:     ${meta.Name}`);
        console.log(`Category: ${meta.Category}`);
        printVersion(meta.Version);
        console.log(`Value:    ${displayValue}`);
        console.log('-'.repeat(60));
      }
    } else {
      console.log(`Failed to fetch metadata: ${response.status}`);
    }
  } catch (error) {
    console.error(`Error fetching metadata: ${error.message}`);
  }
}

function printVersion(version) {
  if (version !== undefined) {
    console.log(`Version:  ${version}`);
  }
}

// Main execution
async function main() {
  const { command, options } = parseArgs();

  if (command === 'discover') {
    discoverServices();
  } else if (command === 'login') {
    if (!options.url || !options.user || !options.password) {
      console.log('Usage: ./lomo_tool.js login --url <server_ip_port> --user <username> --password <password> [--device-id <device_id>]');
      process.exit(1);
    }
    const deviceId = options['device-id'] || 'js-lomo-tool';
    await login(options.url, options.user, options.password, deviceId);
  } else if (command === 'metadata') {
    if (!options.url || !options.token || !options.hash) {
      console.log('Usage: ./lomo_tool.js metadata --url <server_ip_port> --token <token> --hash <hash>');
      process.exit(1);
    }
    await fetchMetadata(options.url, options.token, options.hash);
  } else {
    console.log('Lomorage JavaScript test utility');
    console.log('Usage:');
    console.log('  node lomo_tool.js discover');
    console.log('  node lomo_tool.js login --url <server_ip_port> --user <username> --password <password> [--device-id <device_id>]');
    console.log('  node lomo_tool.js metadata --url <server_ip_port> --token <token> --hash <hash>');
  }
}

main();
