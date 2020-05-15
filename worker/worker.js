/* global importScripts, self, Ipfs, nacl_factory, OrbitDB */
/* global TallyLabIdentities, TallyLabAccess, Keystore, fetch */

// TODO: Why am I patching this?? Doesn't js-ipfs have web worker support?
if (!window) var window = self /* eslint-disable-line */

importScripts('nacl_factory.js')
importScripts('ipfs.min.js')
importScripts('orbitdb.min.js')
importScripts('orbit-db-keystore.min.js')
importScripts('tallylab-orbitdb-identities.min.js')
importScripts('tallylab-orbitdb-access.min.js')

self.tlIdentities = new TallyLabIdentities()
self.tlAccess = new TallyLabAccess()

nacl_factory.instantiate((nacl) => { self.nacl = nacl })

self.onmessage = async (message) => {
  switch (message.data.type) {
    case 'pinning-service-v1':
      self.PINNING_ADDR = message.data.payload
      break
    // Implements the TallyLabIdentityProvider
    // See https://github.com/tallylab/tallylab-orbitdb-access-controller
    case 'identity-v1':
      try {
        self.tlKeys = message.data.payload

        // We instantiate everything once we have an identity to avoid race conditions
        self.ipfs = await Ipfs.create({
          preload: { enabled: false },
          relay: { enabled: true, hop: { enabled: true, active: true } },
          EXPERIMENTAL: { pubsub: true },
          config: {
            Bootstrap: [
              self.PINNING_ADDR
            ],
            Addresses: {
              Swarm: []
            }
          }
        })

        // Manually sign the tlKeys with the OrbitDB ahead of time, via our own keystore
        const id = self.tlKeys.signing.signPk.toString()
        self.keystore = Keystore.create()
        await self.keystore.open()
        const key = await self.keystore.getKey(id) || await self.keystore.createKey(id)
        const idSignature = await self.keystore.sign(key, id)
        const tlSignature = self.nacl.crypto_sign(idSignature, self.tlKeys.signing.signSk)

        // Create an identity with the TallyLabIdentityProvider
        self.identity = await self.tlIdentities.Identities.createIdentity({
          type: 'TallyLab', id, keystore: self.keystore, tlSignature
        })

        // Fire up OrbitDB
        self.orbitdb = await OrbitDB.createInstance(self.ipfs, {
          AccessControllers: self.tlAccess.AccessControllers,
          identity: self.identity
        })

        // Create the snapshotDb
        self.snapshotDb = await self.orbitdb.feed('root', {
          accessController: {
            type: 'tallylab',
            write: [self.identity.id]
          },
          replicate: true,
          sync: true
        })
        await self.snapshotDb.load()

        // Uncomment to check for peers
        // TODO: Replace with proper tracing
        // setInterval(async () => {
        //   const peers = (await self.ipfs.swarm.peers())
        //     .map(p => p.addr.toString())

        //   console.log(peers)
        // }, 2000)

        let replicationDebounce
        self.snapshotDb.events.on('replicated', (address) => {
          clearTimeout(replicationDebounce)
          replicationDebounce = setTimeout(() => {
            self.postMessage({
              type: 'replicated-v1-success',
              payload: { address }
            })
          }, 1000)
        })

        // Uncomment to check for determinism
        // console.log(self.snapshotDb.id)

        const pinningHttpHost = self.PINNING_ADDR.split('/')[2]
        const res = await fetch(`http://${pinningHttpHost}:3000/pin?address=${self.snapshotDb.id}`)
        console.log(await res.text())

        self.postMessage({
          type: 'identity-v1-success',
          payload: {
            id: self.snapshotDb.id,
            lastEntry: self.snapshotDb.iterator({ limit: 1 }).collect()
          }
        })
      } catch (e) { self.postMessage({ type: 'identity-v1-error', payload: e }) }
      break
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
      break
    default:
      console.warn(`Unknown message type: ${message.data.type}`)
      break
  }
}
