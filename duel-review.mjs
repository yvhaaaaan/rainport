const bytes = new TextEncoder();
const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async input => hex(await crypto.subtle.digest('SHA-256', input));
export function digest(value) {
  const json = JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key,v[key]])) : v);
  return sha256(bytes.encode(json));
}
export async function reviewDuel(duel, drivers) {
  const {manifest, manifestHash, commitments, logs} = duel;
  if (await digest(manifest) !== manifestHash) throw Error('发车配置与链上摘要不一致');
  const inputHashes = await Promise.all(logs.map(digest));
  if (inputHashes.some((hash,i) => hash !== commitments[i])) throw Error('原始输入与双方提交的摘要不一致');
  if (!/^[0-9a-f]{64}$/.test(manifest.verifierHash)) throw Error('验证程序版本无效');
  const response = await fetch('/duel/verifiers/' + manifest.verifierHash + '.mjs');
  if (!response.ok) throw Error('未能取得开赛时锁定的验证程序');
  const source = await response.arrayBuffer();
  if (await sha256(source) !== manifest.verifierHash) throw Error('验证程序内容与发车时登记的哈希不符');
  const url = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
  let results;
  try { results = (await import(url)).verifyDuel(manifest, logs); }
  finally { URL.revokeObjectURL(url); }
  const differences = results.filter(r => {
    const live = drivers.find(d => d.id === r.id);
    return !live || live.totalMs !== r.totalMs || live.rank !== r.rank;
  });
  const resultHash = await digest({id:manifest.id,manifestHash,inputHashes,results});
  return {results,inputHashes,resultHash,differences};
}
