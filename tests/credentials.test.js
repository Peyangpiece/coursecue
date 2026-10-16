import test from 'node:test';
import assert from 'node:assert/strict';
import {createCredentialKey, decryptCredentials} from '../local/credential-envelope.js';
import {encryptCredentials} from '../dist/credentials.js';
test('暗号化した認証情報は登録先のMac鍵だけで復号できる', async () => {
  const keys = createCredentialKey();
  const envelope = await encryptCredentials(keys.publicKey, 'test-id', '仮のパスワード');
  assert(!JSON.stringify(envelope).includes('test-id'));
  assert.deepEqual(decryptCredentials(keys.privateKey, envelope), {username: 'test-id', password: '仮のパスワード'});
  assert.throws(() => decryptCredentials(createCredentialKey().privateKey, envelope));
  const bytes = Buffer.from(envelope.data, 'base64');
  bytes[0] ^= 1;
  assert.throws(() => decryptCredentials(keys.privateKey, {...envelope, data: bytes.toString('base64')}));
});
