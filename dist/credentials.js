export async function encryptCredentials(publicJwk, username, password) {
  const rsa = await crypto.subtle.importKey('jwk', publicJwk, {name: 'RSA-OAEP', hash: 'SHA-256'}, false, ['encrypt']);
  const aes = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    aes,
    new TextEncoder().encode(JSON.stringify({username, password}))
  );
  const key = await crypto.subtle.encrypt({name: 'RSA-OAEP'}, rsa, await crypto.subtle.exportKey('raw', aes));
  const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
  return {version: 1, key: b64(key), iv: b64(iv), data: b64(data)};
}
