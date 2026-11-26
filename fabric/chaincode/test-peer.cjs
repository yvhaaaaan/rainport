const assert = require('node:assert/strict');
const {contracts: [Rainport]} = require('./index');

// In-memory test peer. Simulations see the last committed values, and commit
// only when their read versions still match. This is not a Fabric network.
class TestPeer {
  constructor() {
    this.chaincode = new Rainport();
    this.state = new Map();
    this.height = 0;
    this.counter = 0;
    this.seconds = 1000;
  }

  async simulate(actor, fn, ...args) {
    const tx = (++this.counter).toString(16).padStart(64, '0');
    const reads = new Map(), writes = new Map();
    let event;
    const ctx = {
      clientIdentity: {
        getID: () => 'x509::' + actor,
        getMSPID: () => 'Org1MSP',
        assertAttributeValue: (key, value) => actor === 'Admin' && key === 'rainport.admin' && value === 'true'
      },
      stub: {
        getTxID: () => tx,
        getTxTimestamp: () => ({seconds: this.seconds}),
        getCreator: () => ({idBytes: Buffer.from(nonAdminPem)}),
        getState: async key => {
          const current = this.state.get(key);
          reads.set(key, current?.version);
          return current?.value ?? Buffer.alloc(0);
        },
        putState: async (key, value) => writes.set(key, value),
        setEvent: (name, bytes) => { event = [name, JSON.parse(bytes)]; },
        getStateByRange: async (start, end) => {
          const entries = [...this.state.entries()].filter(([k]) => k >= start && k < end);
          return {
            next: async () => entries.length
              ? {value: {value: entries.shift()[1].value}, done: false}
              : {done: true},
            close: async () => {}
          };
        }
      }
    };
    const result = await this.chaincode[fn](ctx, ...args);
    return {result, event, tx, commit: () => {
      for (const [key, version] of reads) {
        assert.equal(this.state.get(key)?.version, version, 'MVCC_READ_CONFLICT');
      }
      if (writes.size) this.height++;
      for (const [key, value] of writes) this.state.set(key, {value, version: this.height});
    }};
  }

  async invoke(actor, fn, ...args) {
    const proposal = await this.simulate(actor, fn, ...args);
    proposal.commit();
    return proposal.result;
  }

  action(actor, fn, ...args) {
    return this.invoke(actor, 'Execute', fn, JSON.stringify(args));
  }

  snapshot() {
    return this.invoke('A', 'Snapshot');
  }
}

// A fixed public-only TLS certificate generated for this test, with OU=client.
const nonAdminPem = `-----BEGIN CERTIFICATE-----
MIIByTCCAW+gAwIBAgIUbUrAOD91o9hS0tJteq7C3tQjw90wCgYIKoZIzj0EAwIw
OjEPMA0GA1UECgwGRmFicmljMQ8wDQYDVQQLDAZjbGllbnQxFjAUBgNVBAMMDXJh
aW5wb3J0LXRlc3QwHhcNMjYxMTI2MDMyMjUxWhcNMzYxMTIzMDMyMjUxWjA6MQ8w
DQYDVQQKDAZGYWJyaWMxDzANBgNVBAsMBmNsaWVudDEWMBQGA1UEAwwNcmFpbnBv
cnQtdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABKkSyDn+AMBLhHM2K2Na
joLpEgsj2N3uOtuOKb/dHA+6g6l6jEEhP1EM/eH6nae2Ak/40H6QIVvVTKuQO2xf
+8ajUzBRMB0GA1UdDgQWBBSjQ8rguVWT1ol10j2OmF/2HmRs3DAfBgNVHSMEGDAW
gBSjQ8rguVWT1ol10j2OmF/2HmRs3DAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIQDampi0lVhTCpvrqW5OxmpSur2bs7inItwkwgOXKdnpCwIgGlZO
HOBg7HidnTKIJM6MgpOEi40J7MefQG0AaXAWSks=
-----END CERTIFICATE-----`;

async function fixture() {
  const db = new TestPeer();
  const roles = ['裁判', 'A', 'B', 'C', '港务车队', '手续费'];
  const bindings = await Promise.all(roles.map(async role => ({
    role, id: (await db.invoke(role, 'WhoAmI')).id
  })));
  const initialize = () => db.invoke('Admin', 'Initialize', JSON.stringify(bindings));
  await initialize();
  const {wallets} = await db.snapshot();
  return {db, initialize, wallets};
}

module.exports = {TestPeer, fixture};
