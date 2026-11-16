#!/usr/bin/env node
import {
  createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual, verify,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

export const METADATA_URI = 'https://raw.githubusercontent.com/paisalrvldoo/makefun-coin-promo/c4b989dec774775aba53a1eccc0de86d08293d4f/metadata.json';
const NAME = 'WILL CODE FOR USDC';
const SYMBOL = 'WILLCODE';
const WEBSITE = 'https://make.fun/bounty/makefun-coin-promo-01';
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const PORTAL_URL = 'https://pumpportal.fun/api/trade-local';
const MINT_PATH = '/home/box/.mkf-coin/mint.json';
const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function base58Encode(bytes) {
  const buffer = Buffer.from(bytes);
  let leading = 0;
  while (leading < buffer.length && buffer[leading] === 0) leading++;
  let number = 0n;
  for (const byte of buffer) number = (number << 8n) | BigInt(byte);
  let encoded = '';
  while (number > 0n) {
    encoded = BASE58[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  return '1'.repeat(leading) + encoded;
}

export function base58Decode(text) {
  if (typeof text !== 'string') throw new Error('Base58 value must be a string');
  let number = 0n;
  for (const character of text) {
    const value = BASE58.indexOf(character);
    if (value < 0) throw new Error('Invalid base58 character');
    number = number * 58n + BigInt(value);
  }
  let leading = 0;
  while (leading < text.length && text[leading] === '1') leading++;
  let hex = number === 0n ? '' : number.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, 'hex')]);
}

export function keypairFromBytes(values) {
  if (!Array.isArray(values) || values.length !== 64 ||
      values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error('Keypair must be a JSON array of exactly 64 bytes');
  }
  const secret = Buffer.from(values);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, secret.subarray(0, 32)]), format: 'der', type: 'pkcs8',
  });
  const publicKeyObject = createPublicKey(privateKey);
  const publicKey = Buffer.from(publicKeyObject.export({ format: 'der', type: 'spki' }).subarray(-32));
  if (!timingSafeEqual(publicKey, secret.subarray(32))) {
    throw new Error('Keypair public half does not match its private seed');
  }
  secret.fill(0);
  return { privateKey, publicKeyObject, publicKey, address: base58Encode(publicKey) };
}

export async function readKeypair(path) {
  let values;
  try {
    values = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // JSON.parse errors can quote input: never propagate key-file contents.
    throw new Error('Cannot read a valid JSON keypair file');
  }
  return keypairFromBytes(values);
}

export async function mintKeypair(path = MINT_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot access mint keypair file');
    const pair = generateKeyPairSync('ed25519');
    const seed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    try {
      await writeFile(path, JSON.stringify([...seed, ...publicKey]) + '\n', { mode: 0o600, flag: 'wx' });
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw new Error('Cannot save mint keypair file');
    }
  }
  const pair = await readKeypair(path);
  await chmod(path, 0o600);
  return pair;
}

export class WireReader {
  constructor(bytes) { this.bytes = Buffer.from(bytes); this.offset = 0; }
  take(length) {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('Truncated Solana transaction');
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  byte() { return this.take(1)[0]; }
  shortvec() {
    let value = 0;
    for (let index = 0; index < 3; index++) {
      const byte = this.byte();
      if (index === 2 && byte > 3) throw new Error('Compact-u16 overflow');
      value |= (byte & 0x7f) << (7 * index);
      if (!(byte & 0x80)) {
        if (index > 0 && byte === 0) throw new Error('Noncanonical compact-u16');
        return value;
      }
    }
    throw new Error('Invalid compact-u16');
  }
}

export function parseTransaction(bytes) {
  const wire = new WireReader(bytes);
  const signatureCount = wire.shortvec();
  if (signatureCount < 1 || signatureCount > 255) throw new Error('Invalid signature count');
  const signatureOffset = wire.offset;
  wire.take(signatureCount * 64);
  const message = wire.take(wire.bytes.length - wire.offset);
  const reader = new WireReader(message);
  let first = reader.byte();
  let version = 'legacy';
  if (first & 0x80) {
    version = first & 0x7f;
    if (version !== 0) throw new Error('Only legacy and v0 messages are supported');
    first = reader.byte();
  }
  const requiredSignatures = first;
  const readonlySigned = reader.byte();
  const readonlyUnsigned = reader.byte();
  const accountCount = reader.shortvec();
  if (signatureCount !== requiredSignatures || accountCount < requiredSignatures ||
      accountCount > 256 || readonlySigned >= requiredSignatures ||
      readonlyUnsigned > accountCount - requiredSignatures) {
    throw new Error('Invalid Solana message header');
  }
  const staticKeys = Array.from({ length: accountCount }, () => reader.take(32));
  reader.take(32); // Recent blockhash is part of the signed message.
  const instructions = [];
  for (let count = reader.shortvec(); count > 0; count--) {
    const programIndex = reader.byte();
    const accounts = [...reader.take(reader.shortvec())];
    const data = reader.take(reader.shortvec());
    instructions.push({ programIndex, accounts, data });
  }
  let loadedAccounts = 0;
  if (version === 0) {
    for (let count = reader.shortvec(); count > 0; count--) {
      reader.take(32);
      const writable = reader.shortvec();
      reader.take(writable);
      const readonly = reader.shortvec();
      reader.take(readonly);
      loadedAccounts += writable + readonly;
    }
  }
  if (reader.offset !== message.length || accountCount + loadedAccounts > 256) {
    throw new Error('Invalid trailing message data or account count');
  }
  for (const instruction of instructions) {
    if ([instruction.programIndex, ...instruction.accounts].some(index => index >= accountCount + loadedAccounts)) {
      throw new Error('Instruction account index is out of bounds');
    }
  }
  return { message, signatureCount, signatureOffset, requiredSignatures, staticKeys, instructions, version };
}

export function signTransaction(bytes, payer, mint) {
  const parsed = parseTransaction(bytes);
  if (!parsed.staticKeys[0].equals(payer.publicKey)) throw new Error('Transaction fee payer does not match wallet');
  if (parsed.requiredSignatures !== 2 || payer.address === mint.address) {
    throw new Error('Create transaction must require exactly the payer and mint signatures');
  }
  const signed = Buffer.from(bytes);
  for (const pair of [payer, mint]) {
    const index = parsed.staticKeys.findIndex(key => key.equals(pair.publicKey));
    if (index < 0 || index >= parsed.requiredSignatures) throw new Error('Required payer/mint signer is missing');
    const signature = sign(null, parsed.message, pair.privateKey);
    if (!verify(null, parsed.message, pair.publicKeyObject, signature)) throw new Error('Ed25519 signature verification failed');
    signature.copy(signed, parsed.signatureOffset + index * 64);
  }
  return { signed, parsed, signature: base58Encode(signed.subarray(parsed.signatureOffset, parsed.signatureOffset + 64)) };
}

function safeError(text) {
  return String(text).replace(/[A-Za-z0-9+/]{100,}={0,2}/g, '[payload omitted]').slice(0, 600);
}

class HttpError extends Error {
  constructor(status, body) { super(`HTTP ${status}: ${safeError(body)}`); this.status = status; }
}

async function response(url, body, retry = true) {
  const attempts = retry ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(25_000),
      });
      if ([429, 502, 503, 504].includes(result.status) && attempt + 1 < attempts) {
        await result.arrayBuffer();
        await pause(500 * (attempt + 1));
        continue;
      }
      if (!result.ok) throw new HttpError(result.status, await result.text());
      return result;
    } catch (error) {
      if (error instanceof HttpError || attempt + 1 === attempts) throw error;
      await pause(500 * (attempt + 1));
    }
  }
}

async function rpc(method, params) {
  const result = await response(RPC_URL, { jsonrpc: '2.0', id: 1, method, params }, method !== 'sendTransaction');
  const data = await result.json();
  if (data.error) throw new Error(`RPC ${method}: ${safeError(data.error.message)}`);
  if (!Object.hasOwn(data, 'result')) throw new Error(`RPC ${method} omitted its result`);
  return data.result;
}

export function sol(lamports) {
  const number = BigInt(lamports);
  const absolute = number < 0n ? -number : number;
  return `${number < 0n ? '-' : ''}${absolute / 1_000_000_000n}.${String(absolute % 1_000_000_000n).padStart(9, '0')}`;
}

export async function simulatePrepared(prepared, rpcCall = rpc) {
  const balance = await rpcCall('getBalance', [prepared.payer.address, { commitment: 'confirmed' }]);
  const simulation = await rpcCall('simulateTransaction', [prepared.signed.toString('base64'), {
    sigVerify: true, encoding: 'base64', commitment: 'confirmed',
    minContextSlot: balance.context.slot,
    accounts: { addresses: [prepared.payer.address], encoding: 'base64' },
  }]);
  const value = simulation.value;
  const after = value.accounts?.[0]?.lamports ?? null;
  if (!Number.isSafeInteger(balance.value) || (after !== null && !Number.isSafeInteger(after))) {
    throw new Error('RPC returned an invalid payer lamport balance');
  }
  if (value.err === null && after === null) throw new Error('RPC omitted the payer post-simulation account');
  const cost = after === null ? null : balance.value - after;
  return {
    err: value.err, last_logs: (value.logs ?? []).slice(-15), unitsConsumed: value.unitsConsumed ?? null,
    payer_balance_now_lamports: balance.value, payer_balance_now_SOL: sol(balance.value),
    payer_lamports_after_sim: after, cost_lamports: cost, SOL_cost: cost === null ? null : sol(cost),
    simulation_slot: simulation.context.slot,
  };
}

export function requireSuccessfulSimulation(report) {
  if (report.err !== null) throw new Error(`Simulation failed: ${safeError(JSON.stringify(report.err))}`);
}

class SimulationError extends Error {
  constructor(prepared) {
    super(`Simulation failed: ${safeError(JSON.stringify(prepared.report.err))}`);
    this.prepared = prepared;
  }
}

function amountFailure(error) {
  const text = `${error.message} ${(error.prepared?.report.last_logs ?? []).join(' ')}`;
  if (/insufficient funds|blockhash|signature verification|account.*not found/i.test(text)) return false;
  return /amount|minimum buy|zero buy|positive|too small|slippage|insufficient (input|output)/i.test(text);
}

async function prepare(payer, mint) {
  async function attempt(lamports) {
    const result = await response(PORTAL_URL, {
      publicKey: payer.address, action: 'create',
      tokenMetadata: { name: NAME, symbol: SYMBOL, uri: METADATA_URI },
      mint: mint.address, denominatedInSol: 'true', amount: lamports / 1_000_000_000,
      slippage: 10, priorityFee: 0.00001, pool: 'pump',
    });
    const bytes = Buffer.from(await result.arrayBuffer());
    const prepared = { ...signTransaction(bytes, payer, mint), payer, mint, lamports };
    if (!prepared.parsed.instructions.some(instruction =>
      [NAME, SYMBOL, METADATA_URI].every(value => instruction.data.includes(Buffer.from(value))))) {
      throw new Error('Create instruction does not contain the approved name, ticker and metadata URI');
    }
    prepared.report = await simulatePrepared(prepared);
    if (prepared.report.err !== null) throw new SimulationError(prepared);
    return prepared;
  }
  try {
    return await attempt(0);
  } catch (error) {
    if (!amountFailure(error)) throw error;
    console.error('amount:0 was rejected; checking the smallest development buy using simulation.');
  }
  // Probe in whole lamports, then bisect to the smallest successful amount.
  let low = 0;
  let high = 1;
  let successful;
  while (high <= 1_000_000) {
    try { successful = await attempt(high); break; }
    catch (error) { if (!amountFailure(error)) throw error; low = high; high *= 2; }
  }
  if (!successful) throw new Error('No working minimal development buy found up to 0.001 SOL');
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    try { successful = await attempt(middle); high = middle; }
    catch (error) { if (!amountFailure(error)) throw error; low = middle; }
  }
  console.error(`Smallest successful development buy: ${sol(successful.lamports)} SOL (${successful.lamports} lamports).`);
  return successful;
}

function printSimulation(mode, prepared) {
  console.log(JSON.stringify({
    mode, payer: prepared.payer.address, mint: prepared.mint.address,
    metadata_uri: METADATA_URI, dev_buy_SOL: sol(prepared.lamports),
    ...prepared.report,
  }, null, 2));
}

async function finalized(signature) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const status = result.value?.[0];
    if (status?.err) throw new Error(`On-chain transaction failed: ${safeError(JSON.stringify(status.err))}`);
    if (status?.confirmationStatus === 'finalized') return;
    await pause(2000);
  }
  throw new Error(`Timed out waiting for finalization; inspect signature ${signature} before retrying`);
}

async function main(args) {
  if (args.length !== 1 || !['--dry-run', '--send'].includes(args[0])) {
    throw new Error('Usage: node launch.mjs --dry-run | --send');
  }
  if (!process.env.WALLET_KEYPAIR) throw new Error('WALLET_KEYPAIR must name the payer JSON keypair file');
  const payer = await readKeypair(process.env.WALLET_KEYPAIR);
  const owner = JSON.parse(await readFile(join(REPO_DIR, '.makefun/owner.json'), 'utf8'));
  if (payer.address !== owner.wallet) throw new Error('Payer does not match the make.fun owner wallet');
  const metadata = JSON.parse(await readFile(join(REPO_DIR, 'metadata.json'), 'utf8'));
  if (metadata.name !== NAME || metadata.symbol !== SYMBOL || metadata.website !== WEBSITE ||
      metadata.description !== await readFile(join(REPO_DIR, 'desc.txt'), 'utf8')) {
    throw new Error('Local metadata no longer matches the approved coin');
  }
  const mint = await mintKeypair();
  let prepared;
  try { prepared = await prepare(payer, mint); }
  catch (error) {
    if (error.prepared) printSimulation(args[0], error.prepared);
    throw error;
  }
  printSimulation(args[0], prepared);
  if (args[0] === '--dry-run') return;
  requireSuccessfulSimulation(prepared.report);
  const signature = await rpc('sendTransaction', [prepared.signed.toString('base64'), {
    encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3,
  }]);
  if (base58Decode(signature).length !== 64 || signature !== prepared.signature) {
    throw new Error('RPC returned an unexpected transaction signature');
  }
  await finalized(signature);
  const launch = { mint: mint.address, create_signature: signature };
  console.log(JSON.stringify({ ...launch, finalized: true }, null, 2));
  const destination = join(REPO_DIR, 'LAUNCH.json');
  await writeFile(destination + '.tmp', JSON.stringify(launch, null, 2) + '\n');
  await rename(destination + '.tmp', destination);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(safeError(error.message));
    process.exitCode = 1;
  });
}
