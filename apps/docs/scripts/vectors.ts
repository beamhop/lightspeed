// Test vectors quoted in docs/PROTOCOL.md, computed with the reference code in @beamhop/p2p/wire.
// Print them with: bun apps/docs/scripts/vectors.ts
import {
  encodeFrame,
  encodeRelayEnvelope,
  FrameType,
  relayHelloHash,
  roomKey,
  roomTopic,
  turnPassword,
  turnUsername,
} from '@beamhop/p2p/wire'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** The secp256k1 generator's x coordinate, used as a well-known example pubkey. */
export const EXAMPLE_PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

export const vectors = {
  topicNoPassword: roomTopic('demo', 'lobby'),
  topicWithPassword: roomTopic('demo', 'lobby', 'hunter2'),
  roomKeyNoPassword: hex(roomKey('demo', 'lobby')),
  relayHelloHash: hex(relayHelloHash('demo', 'aa'.repeat(32))),
  turnUsername: turnUsername(1_700_000_000, 'demo', EXAMPLE_PUBKEY),
  turnPassword: turnPassword('s3cret', turnUsername(1_700_000_000, 'demo', EXAMPLE_PUBKEY)),
  frame: hex(
    encodeFrame({ type: FrameType.Data, streamId: 7, payload: new Uint8Array([0xca, 0xfe]) }),
  ),
  envelope: hex(encodeRelayEnvelope(EXAMPLE_PUBKEY, new Uint8Array([1, 2, 3]))),
}

if (import.meta.main) console.log(JSON.stringify(vectors, null, 2))
