import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const repo = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('.', import.meta.url));
const defaultLocal = path.join(repo, '.fabric-local');
const local = path.resolve(process.env.RAINPORT_FABRIC_NETWORK || defaultLocal);
const version = '2.5.16';
const windows = process.platform === 'win32';
const extension = windows ? '.exe' : '';
const tools = path.join(defaultLocal, `tools-${version}`);
const config = path.join(local, 'config');
const crypto = path.join(local, 'crypto');
const provider = '127.0.0.1';
const basePort = Number(process.env.RAINPORT_FABRIC_BASE_PORT || 17050);
if (!Number.isInteger(basePort)||basePort<1024||basePort>64535) throw Error('RAINPORT_FABRIC_BASE_PORT must be an integer between 1024 and 64535');
const ports = {orderer:basePort, peer:basePort+1, peerChaincode:basePort+2, admin:basePort+3,
  ordererOperations:basePort+4, peerOperations:basePort+5, chaincode:basePort+949};
const channel = 'rainport';
const chaincode = 'rainport';
const profile = 'RainportLocal';
const org = path.join(crypto, 'peerOrganizations', 'org1.example.com');
const ordererOrg = path.join(crypto, 'ordererOrganizations', 'example.com');
const orderer = path.join(ordererOrg, 'orderers', 'orderer.example.com');
const peer = path.join(org, 'peers', 'peer0.org1.example.com');
const admin = path.join(org, 'users', 'Admin@org1.example.com');
const source = path.join(script, 'chaincode');
const builder = path.join(local,'builder');
const block = path.join(local, channel + '.block');
const endpoint = port => `${provider}:${port}`;
const bin = name => path.join(tools, 'bin', name + extension);
const tls = (actor, file) => path.join(actor, 'tls', file);
const key = (actor, dir) => {
  const base = path.join(actor,'msp',dir);
  const found = fs.readdirSync(base);
  if (found.length !== 1) throw Error(`Expected one file in ${base}`);
  return path.join(base, found[0]);
};
const children = [];
let stopping = false;
const cleanEnv = overrides => ({...process.env, ...overrides});

function command(name, args, env={}, {cwd=local, allowFailure=false, quiet=false}={}) {
  const result = spawnSync(name, args, {cwd, env:cleanEnv(env), encoding:'utf8', windowsHide:true, timeout:180000});
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw Error(`${path.basename(name)} ${args.slice(0,4).join(' ')} failed: ${result.stderr || result.stdout}`);
  if (result.status === 0 && !quiet && result.stdout.trim()) console.log(result.stdout.trim());
  return result;
}
function service(name, executable, args, extra, cwd=local) {
  const logPath = path.join(local, name + '.log');
  const log = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(executable, args, {cwd, env:cleanEnv(extra), stdio:['ignore',log,log], windowsHide:true});
  } finally {fs.closeSync(log);}
  child.on('error', error => { console.error(`${name}: ${error.message} (see ${logPath})`); stop(1); });
  child.on('exit', code => {
    if (!stopping) {
      console.error(`${name} stopped (${code ?? 'signal'}). See ${logPath}`);
      stop(1);
    }
  });
  children.push(child);
}
function stop(code=0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of [...children].reverse()) if (child.exitCode === null) child.kill();
}
function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({port,host:provider});
    const finish = value => {socket.destroy(); resolve(value);};
    socket.setTimeout(300, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}
async function waitFor(name, check) {
  for(let i=0;i<70&&!stopping;i++) {
    if(await check())return;
    await delay(250);
  }
  throw Error(`Timed out waiting for ${name}. Check logs in ${local}`);
}
async function getTools() {
  if (fs.existsSync(bin('peer'))) return;
  const targets = {
    'win32-x64':['windows-amd64','fdcefd5e0f9343adf7b2e34461a0d5c531a375ce8c86cf9f4caff48982d07d1c'],
    'linux-x64':['linux-amd64','18c91e7f2f11b601e6622cc70454d568af897707ee9adf111e9fa91a233881bf']
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw Error('The bundled network launcher supports Windows x64 and Linux x64.');
  const [platform, digest] = target;
  const file = `hyperledger-fabric-${platform}-${version}.tar.gz`;
  const archive = path.join(tools,file);
  fs.mkdirSync(tools,{recursive:true});
  if (!fs.existsSync(archive)) {
    console.log(`Downloading the official Fabric ${version} binaries…`);
    command(windows?'curl.exe':'curl',['-fsSL','--retry','2','--output',archive+'.part',
      `https://github.com/hyperledger/fabric/releases/download/v${version}/${file}`]);
    fs.renameSync(archive+'.part',archive);
  }
  const checksum = createHash('sha256');
  for await(const chunk of fs.createReadStream(archive)) checksum.update(chunk);
  if (checksum.digest('hex') !== digest) throw Error(`Fabric archive checksum mismatch: ${archive}`);
  command(windows?'tar.exe':'tar',['-xf',archive,'-C',tools]);
}
function setup() {
  const hooks = path.join(builder,'bin');
  fs.mkdirSync(config,{recursive:true});
  fs.mkdirSync(hooks,{recursive:true});
  for (const file of ['core.yaml','orderer.yaml']) fs.copyFileSync(path.join(tools,'config',file),path.join(config,file));
  const channelConfig = fs.readFileSync(path.join(script,'local-channel.yaml'),'utf8').replaceAll('17050',String(ports.orderer));
  fs.writeFileSync(path.join(config,'configtx.yaml'),channelConfig);
  const core = path.join(config,'core.yaml');
  const fromTools = fs.readFileSync(core,'utf8');
  const withBuilder = fromTools.replace('/opt/hyperledger/ccaas_builder',JSON.stringify(builder));
  if (fromTools === withBuilder) throw Error('Could not set the external chaincode builder in core.yaml');
  fs.writeFileSync(core,withBuilder);
  const detect = path.join(hooks,'detect'+extension);
  command('go',['build','-trimpath','-o',detect,path.join(script,'local-builder.go')],{CGO_ENABLED:'0'});
  for (const name of ['build','release']) {
    const file = path.join(hooks,name+extension);
    fs.copyFileSync(detect,file);
    fs.chmodSync(file,0o700);
  }
  if (!fs.existsSync(admin)) command(bin('cryptogen'),['generate','--config',path.join(script,'local-crypto.yaml'),'--output',crypto]);
  if (!fs.existsSync(block)) command(bin('configtxgen'),['-profile',profile,'-outputBlock',block,'-channelID',channel],{FABRIC_CFG_PATH:config});
}
function archive() {
  const tar = windows?'tar.exe':'tar';
  const file = path.join(local,chaincode+'.tar.gz');
  if (!fs.existsSync(file)) {
    const base = path.join(local,'package');
    fs.mkdirSync(base,{recursive:true});
    fs.writeFileSync(path.join(base,'connection.json'),JSON.stringify({address:endpoint(ports.chaincode),dial_timeout:'10s',tls_required:false}));
    fs.writeFileSync(path.join(base,'metadata.json'),JSON.stringify({path:'',type:'ccaas',label:chaincode+'_1'}));
    command(tar,['-czf','code.tar.gz','connection.json'],{},{cwd:base});
    command(tar,['-czf',file,'metadata.json','code.tar.gz'],{},{cwd:base});
  }
  return file;
}
async function main() {
  fs.mkdirSync(local,{recursive:true});
  const settings = path.join(local,'settings.json');
  if (fs.existsSync(settings)) {
    if (JSON.parse(fs.readFileSync(settings,'utf8')).basePort !== basePort) throw Error('The Fabric data directory was initialized for another port. Choose a new RAINPORT_FABRIC_NETWORK.');
  } else fs.writeFileSync(settings,JSON.stringify({basePort}),{flag:'wx'});
  for (const port of Object.values(ports)) if(await listening(port))throw Error(`Local port ${port} is already in use.`);
  await getTools();
  setup();
  const peerEnv = {
    FABRIC_CFG_PATH:config,
    CORE_PEER_ID:'peer0.org1.example.com',
    CORE_PEER_ADDRESS:endpoint(ports.peer),
    CORE_PEER_LISTENADDRESS:endpoint(ports.peer),
    CORE_PEER_CHAINCODEADDRESS:endpoint(ports.peerChaincode),
    CORE_PEER_CHAINCODELISTENADDRESS:endpoint(ports.peerChaincode),
    CORE_PEER_FILESYSTEMPATH:path.join(local,'peer-data'),
    CORE_LEDGER_SNAPSHOTS_ROOTDIR:path.join(local,'peer-snapshots'),
    CORE_PEER_LOCALMSPID:'Org1MSP',
    CORE_PEER_MSPCONFIGPATH:path.join(peer,'msp'),
    CORE_PEER_GOSSIP_EXTERNALENDPOINT:endpoint(ports.peer),
    CORE_PEER_TLS_ENABLED:'true',
    CORE_PEER_TLS_CERT_FILE:tls(peer,'server.crt'),
    CORE_PEER_TLS_KEY_FILE:tls(peer,'server.key'),
    CORE_PEER_TLS_ROOTCERT_FILE:tls(peer,'ca.crt'),
    CORE_OPERATIONS_LISTENADDRESS:endpoint(ports.peerOperations),
    FABRIC_LOGGING_SPEC:'info'
  };
  const clientEnv = {...peerEnv, CORE_PEER_MSPCONFIGPATH:path.join(admin,'msp')};
  const ordererEnv = {
    FABRIC_CFG_PATH:config,
    ORDERER_GENERAL_LISTENADDRESS:provider,
    ORDERER_GENERAL_LISTENPORT:String(ports.orderer),
    ORDERER_GENERAL_BOOTSTRAPMETHOD:'none',
    ORDERER_GENERAL_LOCALMSPID:'OrdererMSP',
    ORDERER_GENERAL_LOCALMSPDIR:path.join(orderer,'msp'),
    ORDERER_GENERAL_TLS_ENABLED:'true',
    ORDERER_GENERAL_TLS_PRIVATEKEY:tls(orderer,'server.key'),
    ORDERER_GENERAL_TLS_CERTIFICATE:tls(orderer,'server.crt'),
    ORDERER_GENERAL_TLS_ROOTCAS:`[${tls(orderer,'ca.crt')}]`,
    ORDERER_CHANNELPARTICIPATION_ENABLED:'true',
    ORDERER_ADMIN_LISTENADDRESS:endpoint(ports.admin),
    ORDERER_ADMIN_TLS_ENABLED:'true',
    ORDERER_ADMIN_TLS_PRIVATEKEY:tls(orderer,'server.key'),
    ORDERER_ADMIN_TLS_CERTIFICATE:tls(orderer,'server.crt'),
    ORDERER_ADMIN_TLS_CLIENTAUTHREQUIRED:'true',
    ORDERER_ADMIN_TLS_CLIENTROOTCAS:`[${tls(orderer,'ca.crt')}]`,
    ORDERER_FILELEDGER_LOCATION:path.join(local,'orderer-data'),
    ORDERER_CONSENSUS_WALDIR:path.join(local,'orderer-wal'),
    ORDERER_CONSENSUS_SNAPDIR:path.join(local,'orderer-snap'),
    ORDERER_OPERATIONS_LISTENADDRESS:endpoint(ports.ordererOperations),
    FABRIC_LOGGING_SPEC:'info'
  };
  service('orderer',bin('orderer'),[],ordererEnv);
  service('peer',bin('peer'),['node','start'],peerEnv);
  const ordererClient = path.join(ordererOrg,'users','Admin@example.com');
  const osnFlags = ['-o',endpoint(ports.admin),'--ca-file',tls(orderer,'ca.crt'),
    '--client-cert',tls(ordererClient,'client.crt'),'--client-key',tls(ordererClient,'client.key')];
  const ordererFlags = ['-o',endpoint(ports.orderer),'--tls','--cafile', tls(orderer,'ca.crt')];
  const peerFlags = ['--peerAddresses',endpoint(ports.peer),'--tlsRootCertFiles',tls(peer,'ca.crt')];
  const tryQuery = {allowFailure:true,quiet:true};
  await waitFor('peer',()=>listening(ports.peer));
  await waitFor('orderer administration',()=>listening(ports.admin));
  const listOrdererChannel = () => command(bin('osnadmin'),['channel','list','--channelID',channel,...osnFlags],{},tryQuery);
  if (!/Status:\s*200\b/.test(listOrdererChannel().stdout)) {
    const join = command(bin('osnadmin'),['channel','join','--channelID',channel,'--config-block',block,...osnFlags]);
    if (!/Status:\s*201\b/.test(join.stdout)) throw Error('Orderer rejected channel join: '+join.stdout);
  }
  await waitFor('active orderer channel',()=>/"status"\s*:\s*"active"/.test(listOrdererChannel().stdout));
  const newest = path.join(local,'newest.block');
  await waitFor('Raft leader',()=>command(bin('peer'),['channel','fetch','newest',newest,'-c',channel,...ordererFlags],clientEnv,tryQuery).status===0);
  const joined = command(bin('peer'),['channel','list'],clientEnv,{quiet:true});
  if (!joined.stdout.split(/\r?\n/).includes(channel)) command(bin('peer'),['channel','join','-b',block],clientEnv);

  const pkg = archive();
  const prefix = ['lifecycle','chaincode'];
  const id = command(bin('peer'),[...prefix,'calculatepackageid',pkg],clientEnv,{quiet:true}).stdout.trim();
  const installed = command(bin('peer'),[...prefix,'queryinstalled','-O','json'],clientEnv,{quiet:true});
  if (!JSON.parse(installed.stdout).installed_chaincodes?.some(item=>item.package_id===id)) {
    command(bin('peer'),[...prefix,'install',pkg],clientEnv);
  }
  const options = ['-C',channel,'-n',chaincode,'-v','1','--sequence','1'];
  if (command(bin('peer'),[...prefix,'querycommitted','-C',channel,'-n',chaincode],clientEnv,tryQuery).status!==0) {
    command(bin('peer'),[...prefix,'approveformyorg',...options,'--package-id',id,...ordererFlags],clientEnv);
    command(bin('peer'),[...prefix,'commit',...options,...peerFlags,...ordererFlags],clientEnv);
  }
  const chaincodeNode = path.join(source,'node_modules','fabric-shim','cli.js');
  if (!fs.existsSync(chaincodeNode)) {
    if (windows) command('cmd.exe',['/d','/s','/c','npm ci --omit=dev'],{},{cwd:source});
    else command('npm',['ci','--omit=dev'],{},{cwd:source});
  }
  service('chaincode',process.execPath,[chaincodeNode,'server','--chaincode-address='+endpoint(ports.chaincode),'--chaincode-id='+id],{},source);
  await waitFor('chaincode',()=>listening(ports.chaincode));

  const identities = {};
  for (const [role, folder] of Object.entries({'裁判':'Admin',A:'User1',B:'User2',C:'User3','港务车队':'User4','手续费':'User5'})) {
    const actor = path.join(org,'users',folder+'@org1.example.com');
    identities[role] = {mspId:'Org1MSP',certificate:path.relative(local,key(actor,'signcerts')),privateKey:path.relative(local,key(actor,'keystore'))};
  }
  const gateway = path.join(local,'gateway.json');
  await fsp.writeFile(gateway,JSON.stringify({endpoint:endpoint(ports.peer),hostAlias:'peer0.org1.example.com',
    tlsCert:path.relative(local,tls(peer,'ca.crt')),channel,chaincode,identities},null,2),{mode:0o600});
  console.log(`Fabric network ready. Gateway config: ${gateway}`);
  console.log('Keep this terminal running. Ctrl+C stops the peer, orderer, and chaincode service.');
}
process.on('SIGINT',()=>stop());
process.on('SIGTERM',()=>stop());

main().catch(error=>{console.error(error.message);stop(1);});
