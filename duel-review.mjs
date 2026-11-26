const bytes = new TextEncoder();
const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async input => hex(await crypto.subtle.digest('SHA-256', input));
export function digest(value) {
  const json = JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key,v[key]])) : v);
  return sha256(bytes.encode(json));
}
export function matchesPlayerInputs(log, automatic, received, sent) {
  if (!Array.isArray(log) || !Array.isArray(automatic)) return false;
  const releases=new Set(automatic);
  if (releases.size!==automatic.length || automatic.some(n=>!Number.isInteger(n) || n<1 || n>log.length)) return false;
  const manual=[];
  for(const [i,event] of log.entries()) {
    if (!Array.isArray(event)||event.length!==5||event[0]!==i+1) return false;
    if (releases.has(event[0])) {
      if (event.slice(2).some(v=>v!==0)) return false;
    } else manual.push(event);
  }
  if (manual.length!==received) return false;
  return sent.every(([seq,...keys])=>{
    const recorded=manual[seq-1];
    // Inputs sent just after crossing the finish line may be discarded.
    return recorded ? keys.every((v,i)=>v===recorded[i+2]) : seq>received;
  });
}
export async function reviewDuel(duel, drivers) {
  const {manifest, manifestHash, commitments, logs} = duel;
  const individual=manifest.finishPolicy==='individual-v1';
  if (await digest(manifest) !== manifestHash) throw Error('发车配置与链上摘要不一致');
  const roster = manifest.players.map(p => p.id);
  if (roster.length < 2 || roster.length > 4 || new Set(roster).size !== roster.length)
    throw Error('锁定的参赛名单无效');
  if (!Array.isArray(logs) || !Array.isArray(commitments) || logs.length !== roster.length ||
      commitments.length !== roster.length || !logs.every(Array.isArray)) throw Error('参赛车手的驾驶记录不齐全');
  const inputHashes = await Promise.all(logs.map(digest));
  if (individual && (!Array.isArray(duel.inputHashes) || duel.inputHashes.length !== roster.length ||
    duel.inputHashes.some((hash,i) => hash !== inputHashes[i]))) throw Error('原始输入与链上登记的记录摘要不一致');
  if (inputHashes.some((hash,i) => (!individual || commitments[i]) && hash !== commitments[i]))
    throw Error('原始输入与车手提交的摘要不一致');
  if (!/^[0-9a-f]{64}$/.test(manifest.verifierHash)) throw Error('验证程序版本无效');
  const response = await fetch('/duel/verifiers/' + manifest.verifierHash + '.mjs');
  if (!response.ok) throw Error('未能取得开赛时锁定的验证程序');
  const source = await response.arrayBuffer();
  if (await sha256(source) !== manifest.verifierHash) throw Error('验证程序内容与发车时登记的哈希不符');
  const url = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
  let results;
  try { results = (await import(url)).verifyDuel(manifest, logs, duel.withdrawals); }
  finally { URL.revokeObjectURL(url); }
  if (!Array.isArray(results) || results.length !== roster.length || results.some((r,i) => r.id !== roster[i]))
    throw Error('验证程序返回的赛果与参赛名单不符');
  const differences = results.filter(r => {
    const live = drivers.find(d => d.id === r.id);
    return !live || live.totalMs !== r.totalMs || live.rank !== r.rank || (live.dnfStep??null)!==(r.dnfStep??null);
  });
  const payload={id:manifest.id,manifestHash,inputHashes,results};
  if(individual) payload.withdrawals=duel.withdrawals;
  const resultHash = await digest(payload);
  if (individual && (resultHash !== duel.resultHash || await digest(results)!==await digest(duel.results)))
    throw Error('本机复算与链上官方验证结果不一致');
  return {results,inputHashes,resultHash,differences};
}
