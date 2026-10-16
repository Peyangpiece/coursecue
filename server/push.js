// Web Push（RFC 8030・8291・8292）を Workers の WebCrypto だけで送る（外部ライブラリなし）。
// VAPID の鍵は最初に使うとき 1 度だけ作って D1（push_keys）に置く。購読（endpoint と鍵）は利用者ごとに push_subscriptions に残す。
// 通知の種類：PC が状態を保存するたびに前の状態と比べて「出席コードの入力が出た」「新しいお知らせ」、毎朝の定期処理で「24 時間以内に締切の課題」
const enc = new TextEncoder();
export const b64u = {
  encode: bytes =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
  decode: s => {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), c => c.charCodeAt(0));
  }
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
// VAPID の鍵の組（公開鍵は 65 バイトの raw を base64url、秘密鍵は JWK）
export async function generateVapid() {
  const k = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', k.privateKey);
  return {
    publicKey: b64u.encode(await crypto.subtle.exportKey('raw', k.publicKey)),
    privateJwk: {kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d}
  };
}
export async function vapidKeys(store) {
  const have = await store.getPushKeys();
  if (have?.publicKey && have?.privateJwk) return have;
  const made = await generateVapid();
  await store.putPushKeys(made);
  return made;
}
// Authorization: vapid t=<JWT（ES256。aud はプッシュサービスのオリジン、12 時間有効）>, k=<公開鍵>
export async function vapidAuth(endpoint, vapid, subject, now = Date.now()) {
  const key = await crypto.subtle.importKey(
    'jwk',
    {...vapid.privateJwk, ext: true},
    {name: 'ECDSA', namedCurve: 'P-256'},
    false,
    ['sign']
  );
  const part = o => b64u.encode(enc.encode(JSON.stringify(o)));
  const head = part({typ: 'JWT', alg: 'ES256'}),
    claims = part({aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject});
  const sig = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u.encode(sig)}, k=${vapid.publicKey}`;
}
// 本文の暗号化（aes128gcm・RFC 8291）：購読者の公開鍵（p256dh）と auth から鍵を導き、1 レコード（4096 バイト）で送る
export async function encryptPayload(plain, keys) {
  const ua = b64u.decode(keys.p256dh),
    authSecret = b64u.decode(keys.auth);
  const uaKey = await crypto.subtle.importKey('raw', ua, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  const as = await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const shared = await crypto.subtle.deriveBits({name: 'ECDH', public: uaKey}, as.privateKey, 256);
  const hkdf = async (ikm, salt, info, len) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {name: 'HKDF', hash: 'SHA-256', salt, info},
        await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
        len * 8
      )
    );
  const ikm = await hkdf(shared, authSecret, concat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16),
    nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, key, concat(plain, new Uint8Array([2])))
  );
  // ヘッダー：salt(16) + rs(4、4096) + idlen(1) + 送り手の公開鍵(65)
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, cipher);
}
// 1 つの購読に送る。返り値はプッシュサービスの HTTP 状態（201 が成功。404・410 は購読が消えている）
export async function sendPush(sub, payload, vapid, subject) {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.keys);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(payload.ttl || 86400),
      Urgency: payload.urgency || 'normal',
      Authorization: await vapidAuth(sub.endpoint, vapid, subject)
    },
    body
  });
  return r.status;
}
export const DEFAULT_SUBJECT = 'https://coursecue.hrk-6888.workers.dev/';
// 利用者のすべての端末に送る。消えた購読（404・410）は消す。送れた数を返す
export async function pushAccount(store, account, payload, subject = DEFAULT_SUBJECT) {
  const subs = await store.listPushSubscriptions(account);
  if (!subs.length) return 0;
  const vapid = await vapidKeys(store);
  let sent = 0;
  for (const s of subs) {
    try {
      const status = await sendPush(
        {endpoint: s.endpoint, keys: {p256dh: s.p256dh, auth: s.auth}},
        payload,
        vapid,
        subject
      );
      if (status === 404 || status === 410) await store.deletePushSubscription(account, s.endpoint);
      else if (status < 300) sent++;
      else console.error('saboro: 通知を送れません', status);
    } catch (e) {
      console.error('saboro: 通知を送れません', e.message);
    }
  }
  return sent;
}
// PC が保存した状態の前後を比べて出す通知：出席コードの入力（prompts に新しいもの）、新しいお知らせ（newNotices に新しいキー）
export function stateEvents(prev, next) {
  const out = [],
    before = prev?.prompts || {};
  for (const [name, p] of Object.entries(next?.prompts || {}))
    if (before[name]?.at !== p?.at)
      out.push({
        title: `${name}：出席コードの入力が出ています`,
        body: String(p?.message || '出席コードを入力してください').slice(0, 100),
        url: '/#v=home',
        tag: 'prompt:' + name,
        urgency: 'high'
      });
  const known = new Set((prev?.newNotices || []).map(n => n.key)),
    fresh = (next?.newNotices || []).filter(n => n && !known.has(n.key));
  if (fresh.length === 1)
    out.push({
      title: `新しいお知らせ：${fresh[0].course}`,
      body: String(fresh[0].title || '').slice(0, 100),
      url: '/#v=home',
      tag: 'notice'
    });
  else if (fresh.length > 1)
    out.push({
      title: `新しいお知らせ ${fresh.length} 件`,
      body: fresh
        .map(n => `${n.course}：${n.title}`)
        .join('\n')
        .slice(0, 200),
      url: '/#v=home',
      tag: 'notice'
    });
  return out;
}
const dueText = iso =>
  new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
// 毎朝の通知：24 時間以内に締切の未提出の課題
export function deadlineEvents(state, now = Date.now()) {
  const due = t => new Date(t.dueAt).getTime();
  const soon = (state?.tasks || []).filter(
    t => t && t.status !== 'done' && t.dueAt && due(t) > now && due(t) - now <= 24 * 3600e3
  );
  if (!soon.length) return [];
  const names = (state.courses || []).map(c => c.name);
  return [
    {
      title: soon.length === 1 ? '締切が近い課題があります' : `締切が近い課題 ${soon.length} 件`,
      body: soon
        .map(t => `${names[t.course] ?? ''}：${t.title}（${dueText(t.dueAt)}）`)
        .join('\n')
        .slice(0, 200),
      url: '/#v=tasks',
      tag: 'deadline'
    }
  ];
}
// 定期処理：通知を受け取る端末がある利用者ごとに、締切が近い課題を知らせる
export async function pushDeadlines(store, now = Date.now(), subject = DEFAULT_SUBJECT) {
  let sent = 0;
  for (const account of await store.listPushAccounts()) {
    const value = await store.getState(account);
    if (!value) continue;
    let state;
    try {
      state = JSON.parse(value);
    } catch {
      continue;
    }
    for (const ev of deadlineEvents(state, now)) sent += await pushAccount(store, account, ev, subject);
  }
  return sent;
}
