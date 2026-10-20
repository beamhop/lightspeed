import type { Hex, IdentityProvider } from '../types'
import { hexToBytes } from '../util/bytes'
import { generateSecretKey, keyIdentity, type LocalIdentity } from './key'

/** Where persisted identity keys live. The default uses IndexedDB when available. */
export interface KeyStorage {
  get(name: string): Promise<Uint8Array | null>
  set(name: string, key: Uint8Array): Promise<void>
}

export function memoryKeyStorage(): KeyStorage & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>()
  return {
    data,
    async get(name) {
      return data.get(name) ?? null
    },
    async set(name, key) {
      data.set(name, key)
    },
  }
}

const DB = 'beamhop'
const STORE = 'identity'

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** IndexedDB-backed key storage; resolves to no persistence where IndexedDB does not exist (Bun, Node). */
export function indexedDbKeyStorage(): KeyStorage {
  const idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  let dbp: Promise<IDBDatabase> | null = null
  const open = () => {
    if (!idb) return null
    if (!dbp) {
      const req = idb.open(DB, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE)
      }
      dbp = idbRequest(req)
    }
    return dbp
  }
  return {
    async get(name) {
      const db = await open()
      if (!db) return null
      const v = await idbRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(name))
      return v instanceof Uint8Array ? v : null
    },
    async set(name, key) {
      const db = await open()
      if (!db) return
      await idbRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).put(key, name))
    },
  }
}

export interface AnonymousOptions {
  /** Use a fixed secret key (hex or bytes), e.g. for tests or Bun server peers. */
  secretKey?: Uint8Array | Hex
  /** Persist the key across reloads. `true` uses the name 'default'. */
  persist?: boolean | string
  storage?: KeyStorage
}

/** Ephemeral secp256k1 identity, optionally persisted in IndexedDB. */
export interface LocalIdentityProvider extends IdentityProvider {
  load(): Promise<LocalIdentity>
}

export function anonymous(opts: AnonymousOptions = {}): LocalIdentityProvider {
  return {
    kind: 'anonymous',
    async load() {
      if (opts.secretKey) {
        const sk = typeof opts.secretKey === 'string' ? hexToBytes(opts.secretKey) : opts.secretKey
        return keyIdentity(sk, [{ type: 'anonymous' }])
      }
      if (opts.persist) {
        const name = `anonymous:${opts.persist === true ? 'default' : opts.persist}`
        const storage = opts.storage ?? indexedDbKeyStorage()
        let sk = await storage.get(name).catch(() => null)
        if (!sk) {
          sk = generateSecretKey()
          await storage.set(name, sk).catch(() => {})
        }
        return keyIdentity(sk, [{ type: 'anonymous' }])
      }
      return keyIdentity(generateSecretKey(), [{ type: 'anonymous' }])
    },
  }
}
