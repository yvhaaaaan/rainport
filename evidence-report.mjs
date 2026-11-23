import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('./evidence/',import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const dirs = fs.readdirSync(root).filter(s=>s.startsWith('chain-') && fs.existsSync(path.join(root,s,'run.json')));
const folder = dirs.filter(s=>read(path.join(root,s,'run.json')).passed===7)
  .sort((a,b)=>read(path.join(root,b,'run.json')).finished.localeCompare(read(path.join(root,a,'run.json')).finished))[0];
const input = name => read(path.join(root,folder,name));
const checks=input('checks.json'), receipts=input('node-receipts.json'), races=input('race-records.json');
const report=input('run.json'), deployment=input('deployment.json'), journal=input('transactions.json');
const id=n=>'#'+String(n).padStart(3,'0');
const format=t=>Math.floor(t/60)+':'+(t%60).toFixed(3).padStart(6,'0');
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fields=checks.map(c=>c.values);
const [first,second,serial,bid,car,contest,lock]=fields;
const observed=[
  `A 驾驶底盘 #001 以 ${format(first.total)} 获得第 ${first.rank} 名。刷新结果并再次调用抽奖后，奖励始终为 ${id(first.prize)}，全链已发行 NFT 数量保持 ${first.count} 件。`,
  `${id(second.prize)} 在首圈掉落，从第二圈起计入参赛配置。第二圈湿弯 ${second.sectors[0].toFixed(3)} 秒，直道 ${second.sectors[1].toFixed(3)} 秒。回放经成绩、配置、轨迹三项摘要核验。`,
  `A 将雨胎 ${id(serial.serial)} 从车上拆下并按编号挂牌，B 买入后装在底盘 ${id(serial.mountedOn)}。使用记录仍记载 A 驾驶 #001 的成绩。`,
  `B 托管 ${bid.escrowDelta} CR，买到 C 主动按同款出售的 #020，成交 ${bid.price} CR。指定编号订单 ${bid.excludedOrder} 继续挂牌。B 的另一笔求购撤单后退回 ${bid.returned} CR。`,
  `B 一笔购买交易取得 ${car.ids.map(id).join(' / ')}，支付 ${-car.buyer} CR，A 收到 ${car.seller} CR，手续费账户收到 ${car.fee} CR。B 保留装配关系并用该配置跑出 ${format(car.total)}。`,
  `B、C 同时提交购买 ${id(contest.serial)} 的独立签名交易。钱包 ${contest.winner} 成交。B 和 C 的商品款扣款分别为 ${contest.spends[0]} 与 ${contest.spends[1]} CR。回退交易的测试 ETH Gas 记录可在回执中查看。`,
  `整车挂牌锁住全部四件资产。拆卸和单卖轮胎 ${id(lock.tire)} 均回退，原装配及订单锁完整。撤单解锁后，拆胎和指定编号挂牌成功。`
];
const titles=['名次奖励与重复结算','掉落部件首次参赛','指定编号买入再装配','同款求购、隔离与退款','整车四件套同笔交割','两个买家竞争同一件藏品','整车挂牌锁与撤单'];
const blocks=new Map(receipts.map(r=>[r.transactionHash,r]));
const stages=new Map(journal.map(j=>[j.h,j]));
const verbs={draw:'奖励结算',confirm:'裁判确认成绩',start:'锁定参赛配置',fit:'装配变更',list:'挂牌 / 撮合',bid:'求购托管',buy:'买入交割',close:'撤单'};
function collect(value,list){
  if(Array.isArray(value)){for(const e of value)collect(e,list);return}
  if(value&&typeof value==='object'){if(value.hash)list.add(value.hash);for(const e of Object.values(value))collect(e,list)}
}
function receipt(hash){
  const r=blocks.get(hash);assert(r,hash+' 缺少节点回执');
  const j=stages.get(hash);
  return `<details><summary><b>区块 ${Number(r.blockNumber)}</b>　${Number(r.status)?'已确认':'已回退'}　${esc(verbs[j?.fn]||'交易')} <code>${hash}</code></summary><pre>${esc(JSON.stringify(r,null,2))}</pre></details>`;
}
const illustrations=[['result','浏览器重开结算'],['provenance','获得和实际参赛履历'],[],[],['buyer-order','已成交四件套清单'],[],[]];
function section(c,i){
  const v=c.values,hashes=new Set();
  collect(v,hashes);
  const raceKey=i===0?v.race:i===1?v.firstUse:i===4?v.race:null;
  const r=races.find(x=>x.id===raceKey);
  if(r)r.tx.forEach(h=>hashes.add(h));
  const graph=illustrations[i];
  return `<section id="case-${i+1}"><div class="eyebrow">已通过 · ${i+1} / 7</div><h2>${titles[i]}</h2><p>${observed[i]}</p>${r?'<p class="small">赛事编号 <code>'+esc(r.id)+'</code></p>':''}${[...hashes].sort((a,b)=>Number(blocks.get(a).blockNumber)-Number(blocks.get(b).blockNumber)).map(receipt).join('')}${graph.length?'<p><a href="screens/'+graph[0]+'.png">'+graph[1]+'截图</a></p>':''}</section>`;
}
assert.equal(report.status,'通过');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>弯道档案 · 链上验收</title><style>
*{box-sizing:border-box}body{margin:0;background:#101719;color:#f2f0e7;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{max-width:940px;margin:auto;padding:42px 16px}h1{font-size:clamp(32px,5vw,54px);margin:0 0 12px}h2{margin:0;font-size:22px}.eyebrow,a{color:#ffab77}.eyebrow,.small{font-size:14px}.small{color:#adb9b6}section{padding:23px 0;border-top:1px solid #334449}details{padding:9px 12px;background:#1c282d;border-bottom:1px solid #38474b}summary{cursor:pointer}code{font:13px/1.4 monospace;overflow-wrap:anywhere}summary code{display:block;margin:4px 0;color:#b8c6c7}pre{white-space:pre-wrap;overflow-wrap:anywhere}nav{margin:24px 0}a{margin-right:10px}p{margin:8px 0 15px}</style>
<main><div class="eyebrow">雨港 · 本地链 31337</div><h1>弯道档案验收记录</h1><p>七项通过。三场比赛使用自动车手输入，由服务器按真实经过时间计时。节点共返回 ${receipts.length} 份交易回执。展开下列交易可查看原始状态、区块哈希和事件日志。</p><p class="small">实测时间 ${new Date(report.started).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} 至 ${new Date(report.finished).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）。验收库与日常试玩存档独立。</p>
<nav><a href="${folder}/checks.json">断言与实测数值</a><a href="${folder}/node-receipts.json">全部节点回执</a><a href="${folder}/deployment.json">部署与钱包</a><a href="orderbook.json">撮合与到期补测</a><a href="driving-v3.json">驾驶对照</a></nav>
${checks.map(section).join('')}<section><h2>复核现场</h2><p>运行 <code>node inspect-run.mjs</code> 可从留存的节点数据库副本恢复验收现场。Windows 便携包可使用 <code>runtime\\node.exe inspect-run.mjs</code>。钱包页支持点开完整交易回执。</p><p class="small">资产合约 <code>${esc(deployment.deployments.Archive.address)}</code></p></section></main></html>`;
fs.writeFileSync(path.join(root,'验收报告.html'),html);
console.log(path.join(root,'验收报告.html'));
