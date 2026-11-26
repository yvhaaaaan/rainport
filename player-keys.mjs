const signingContext = 'rainport.player.action.v1';
const p256 = {name: 'ECDSA', namedCurve: 'P-256'};

function subtle() {
  if (!globalThis.crypto?.subtle) throw Error('玩家签名需要 HTTPS 或 localhost');
  return globalThis.crypto.subtle;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function createPlayerKey() {
  const pair = await subtle().generateKey(p256, false, ['sign', 'verify']);
  const rawKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const digest = new Uint8Array(await subtle().digest('SHA-256', rawKey));
  const id = 'player:' + Array.from(digest, x => x.toString(16).padStart(2, '0')).join('');
  return {id, publicKey: base64url(rawKey), privateKey: pair.privateKey};
}

export async function signPlayerAction(key, domain, nonce, action, args) {
  const payload = JSON.stringify([signingContext, domain, key.id, nonce, action, args], (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value);
  const signature = await subtle().sign({name: 'ECDSA', hash: 'SHA-256'}, key.privateKey,
    new TextEncoder().encode(payload));
  return {id: key.id, publicKey: key.publicKey, domain, nonce, action, args,
    signature: base64url(new Uint8Array(signature))};
}

// CryptoKey is structured-cloneable. IndexedDB keeps the private key non-exportable.
function keyStore(alias, candidate) {
  if (typeof alias !== 'string' || !alias.trim() || alias.trim().length > 80) {
    throw Error('请输入 1 到 80 个字符的本机账户名');
  }
  alias = alias.trim();
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('rainport-player-keys', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('keys', candidate ? 'readwrite' : 'readonly');
      const store = tx.objectStore('keys');
      const read = store.get(alias);
      let result;
      read.onsuccess = () => {
        result = read.result || candidate || null;
        if (!read.result && candidate) store.add(candidate, alias);
      };
      tx.onabort = () => { db.close(); reject(tx.error || Error('无法读取本机账户')); };
      tx.oncomplete = () => { db.close(); resolve(result); };
    };
  });
}

export function findPlayerKey(alias = 'default') {
  return keyStore(alias, null);
}

export async function loadPlayerKey(alias = 'default') {
  return (await findPlayerKey(alias)) || keyStore(alias, await createPlayerKey());
}
