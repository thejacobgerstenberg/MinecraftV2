// Remote-player avatars — re-export of the animated rig package
// (public/src/avatars/, from feature/avatars). Same API surface as the old
// flat-box renderer, so main.js wiring is unchanged:
//
//   peers.upsert({id, name, x, y, z, yaw, dim})  — add or update a peer
//   peers.move({id, x, y, z, yaw, dim})          — update the lerp target
//   peers.remove(id)                              — remove + dispose one peer
//   peers.setDimension(dim)   — only avatars in `dim` are visible
//   peers.update(dt)          — advance smoothing + walk/idle animation
//   peers.count / peers.ids   — for HUD/debug/QA
//   peers.dispose()           — remove + dispose everything
//
// Peer position convention matches Player.position: the MIN corner of the
// 0.6 x 1.8 x 0.6 AABB (feet); the adapter centers the rig on the column
// (+0.3 on x/z), same as the old renderer. Groups keep the `peer:<id>` name
// for QA hooks. Skins are deterministic per network id; the walk cycle is
// derived from smoothed position deltas.
export { PeerAvatars } from '../avatars/peer-avatars.js';
