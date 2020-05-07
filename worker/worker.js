// TODO: Why am I patching this?? Doesn't js-ipfs have web worker support?
if (!window) var window = self;

importScripts('nacl_factory.js');
importScripts('ipfs.min.js');
importScripts('orbitdb.min.js');
importScripts('orbit-db-keystore.min.js');
importScripts('tallylab-orbitdb-identities.min.js');
importScripts('tallylab-orbitdb-access.min.js');

self.tlIdentities = new TallyLabIdentities()
self.tlAccess = new TallyLabAccess()

nacl_factory.instantiate((nacl) => {
  self.nacl = nacl
});

self.onmessage = async (message) => {
  switch(message.data.type) {
    // Implements the TallyLabIdentityProvider
    // See https://github.com/tallylab/tallylab-orbitdb-access-controller
    case 'identity-v1':
      try {
        const tlKeys = message.data.payload

        // We instantiate everything once we have an identity to avoid race conditions
        self.ipfs = await Ipfs.create({
          preload: { enabled: false },
          relay: { enabled: true, hop: { enabled: true, active: true } },
          EXPERIMENTAL: { pubsub: true },
          config: { Bootstrap: [], Addresses: { Swarm: [] }}
        });

        // Manually sign the tlKeys with the OrbitDB ahead of time, via our own keystore
        const id = tlKeys.signing.signPk.toString()
        self.keystore = Keystore.create()
        await self.keystore.open()
        const key = await self.keystore.getKey(id) || await self.keystore.createKey(id)
        const idSignature = await self.keystore.sign(key, id)
        const tlSignature = self.nacl.crypto_sign(idSignature, tlKeys.signing.signSk)

        // Create an identity with the TallyLabIdentityProvider
        self.identity = await tlIdentities.Identities.createIdentity({
          type: 'TallyLab', id, keystore: self.keystore, tlSignature
        })

        // Fire up OrbitDB
        self.orbitdb = await OrbitDB.createInstance(self.ipfs, {
          AccessControllers: tlAccess.AccessControllers,
          identity: self.identity
        })

        // Create the snapshotDb
        self.snapshotDb = await orbitdb.feed('root', {
          accessController: {
            type: 'tallylab',
            write: [identity.id]
          }
        })
        await self.snapshotDb.load()

        // Leaving this here and commented out to remember to check for determinism
        // console.log(self.snapshotDb.id)

        self.postMessage({
          type: 'identity-v1-success',
          payload: {
            id: self.snapshotDb.id,
            lastEntry: self.snapshotDb.iterator({ limit: 1 }).collect()
          }
        })
      } catch (e) { self.postMessage({ type: 'identity-v1-error', payload: e }) }
      break;
    case 'snapshot-v1':
      try {
        // Let's get rid of the pKey since we don't need it stored in the db entry
        delete message.data.payload.pKey
        await self.snapshotDb.load()
        await self.snapshotDb.add(message.data.payload)
        self.postMessage({
          type: 'snapshot-v1-success',
          payload: self.snapshotDb.index
        })
      } catch (e) { self.postMessage({ type: 'snapshot-v1-error', payload: e }) }
      break;
    default:
      console.warn('unknown message type')
      break;
  }
}


