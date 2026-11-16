import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base58Encode, base58Decode, keypairFromBytes, mintKeypair, readKeypair,
  parseTransaction, signTransaction, WireReader, simulatePrepared, requireSuccessfulSimulation,
} from '../launch.mjs';

function keypair() {
  const pair = generateKeyPairSync('ed25519');
  return keypairFromBytes([
    ...pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    ...pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]);
}

function transaction(payer, mint, version = 0, lookups = false) {
  const message = Buffer.concat([
    version === 'legacy' ? Buffer.alloc(0) : Buffer.from([0x80 | version]),
    Buffer.from([2, 0, 1, 3]), payer.publicKey, mint.publicKey, Buffer.alloc(32, 7),
    Buffer.alloc(32, 9), Buffer.from([1, 2, 2, 0, 1, 6]), Buffer.from('create'),
    version === 'legacy' ? Buffer.alloc(0) : lookups
      ? Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 4), Buffer.from([2, 8, 9, 1, 3])])
      : Buffer.from([0]),
  ]);
  return Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message]);
}

test('base58 matches independent standard vectors and preserves leading zeros', () => {
  for (const [hex, encoded] of [['', ''], ['00', '1'], ['0000', '11'], ['01', '2'],
    ['ff', '5Q'], ['61', '2g'], ['626262', 'a3gV'], ['636363', 'aPEr']]) {
    assert.equal(base58Encode(Buffer.from(hex, 'hex')), encoded);
    assert.equal(base58Decode(encoded).toString('hex'), hex);
  }
  assert.throws(() => base58Decode('0OIl'), /Invalid base58/);
});

test('compact-u16 boundaries and malformed encodings', () => {
  assert.equal(new WireReader([0x7f]).shortvec(), 127);
  assert.equal(new WireReader([0x80, 1]).shortvec(), 128);
  assert.equal(new WireReader([0xff, 0xff, 3]).shortvec(), 65535);
  assert.throws(() => new WireReader([0x80, 0]).shortvec(), /Noncanonical/);
  assert.throws(() => new WireReader([0xff, 0xff, 4]).shortvec(), /overflow/);
  assert.throws(() => new WireReader([0x80]).shortvec(), /Truncated/);
});

test('legacy/v0 parsing and signing are independently verified with Ed25519', () => {
  const payer = keypair();
  const mint = keypair();
  for (const version of ['legacy', 0]) {
    const wire = transaction(payer, mint, version, version === 0);
    const parsed = parseTransaction(wire);
    assert.equal(parsed.version, version);
    assert.equal(parsed.instructions[0].data.toString(), 'create');
    const signed = signTransaction(wire, payer, mint);
    assert.equal(signed.signed.subarray(129).equals(parsed.message), true);
    assert.equal(verify(null, parsed.message, payer.publicKeyObject, signed.signed.subarray(1, 65)), true);
    assert.equal(verify(null, parsed.message, mint.publicKeyObject, signed.signed.subarray(65, 129)), true);
    const tampered = Buffer.from(parsed.message);
    tampered[tampered.length - 1] ^= 1;
    assert.equal(verify(null, tampered, payer.publicKeyObject, signed.signed.subarray(1, 65)), false);
    assert.equal(base58Decode(signed.signature).length, 64);
  }
  assert.throws(() => parseTransaction(transaction(payer, mint, 1)), /Only legacy and v0/);
  assert.throws(() => parseTransaction(transaction(payer, mint).subarray(0, -1)), /Truncated/);
  assert.throws(() => signTransaction(transaction(payer, mint), keypair(), mint), /fee payer/);
  assert.throws(() => signTransaction(transaction(payer, mint), payer, keypair()), /signer is missing/);
});

test('mint persistence uses mode 600 and key-file errors never quote secret input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'willcode-mint-test-'));
  try {
    const file = join(directory, 'mint.json');
    const first = await mintKeypair(file);
    const second = await mintKeypair(file);
    assert.equal(first.address, second.address);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, '[not-valid-json-secret-sentinel');
    await assert.rejects(readKeypair(file), error =>
      error.message === 'Cannot read a valid JSON keypair file' && !error.message.includes('sentinel'));
    assert.throws(() => keypairFromBytes(Array(64).fill(0)), /public half/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulation requests signature verification and payer account; it never broadcasts', async () => {
  const payer = keypair();
  const mint = keypair();
  const prepared = { ...signTransaction(transaction(payer, mint), payer, mint), payer, mint };
  const methods = [];
  const report = await simulatePrepared(prepared, async (method, params) => {
    methods.push(method);
    if (method === 'getBalance') return { context: { slot: 100 }, value: 80_000_000 };
    assert.equal(method, 'simulateTransaction');
    assert.equal(params[1].sigVerify, true);
    assert.equal(params[1].encoding, 'base64');
    assert.equal(params[1].accounts.encoding, 'base64');
    assert.deepEqual(params[1].accounts.addresses, [payer.address]);
    assert.equal(params[1].minContextSlot, 100);
    return { context: { slot: 101 }, value: {
      err: null, logs: ['Program success'], unitsConsumed: 90_000, accounts: [{ lamports: 74_000_000 }],
    } };
  });
  assert.deepEqual(methods, ['getBalance', 'simulateTransaction']);
  assert.equal(report.SOL_cost, '0.006000000');
  assert.equal(report.payer_lamports_after_sim, 74_000_000);
  requireSuccessfulSimulation(report);
  assert.throws(() => requireSuccessfulSimulation({ err: { InstructionError: [0, 'InvalidArgument'] } }), /Simulation failed/);
});
