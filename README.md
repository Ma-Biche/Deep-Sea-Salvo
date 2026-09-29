# Deep Sea Salvo

Co-op 3D fish shooter for 1–4 players. You ride a boat at the surface and shoot into the sea. Everyone shares one ocean, and every catch is split by how much damage each captain dealt.

Frontend: HTML, CSS, JavaScript with Three.js (vendored, no CDN needed). Backend: Go standard library only (no modules to download).

## Run it

Requires Go 1.22 or newer.

```
go run .
```

Open http://localhost:8080, create an account, and press **Start a room**. To play together, share the 5-letter room code shown top-left. Friends on the same network open `http://<your-ip>:8080` and join with the code. Over the internet you need to port-forward 8080 or put it behind a reverse proxy (use `wss` if you serve HTTPS).

Flags: `-config server-config.json`, `-data data`, `-web web`, and `-dev`. The `-dev` flag makes bosses surface after a few kills and is meant for testing only.

Profiles are saved in `data/profiles.json`, written atomically every 5 seconds and on Ctrl+C. The signing key for login tokens is in `data/secret.key`. Delete `data/` to wipe all accounts.

Run the tests with `go test -race .` (loot conservation, rounding, pacing).

## Controls

- **Aim:** mouse, or touch-drag.
- **Fire:** hold the mouse button or finger down. **Space** toggles auto-fire.
- **1–7:** switch blasters. A locked one opens the Armory.
- **M:** mute. **Esc:** menu (leave the room, redeem, settings).

The game never pauses, because other players are in the same ocean. Level-up picks appear in a tray you can use while playing.

## How the loot split works

1. Each fish records how much damage each player dealt to it. Only damage that actually removed HP counts, so a big overkill shot doesn't inflate anyone's share.
2. When it dies, its coins and XP are split by those shares. Coins use largest-remainder rounding, so the total paid out always equals the fish's value exactly. A very small share of a cheap fish can round to 0 coins.
3. Your personal Deep Pockets and Sea Legs upgrades then multiply your own cut. They never reduce anyone else's.
4. If a player leaves, their damage on living fish is dropped, and whoever finishes those fish shares the loot.
5. Enemy HP and coin values both scale with player count (+65% per extra player), so income per player stays roughly the same whether you play solo or in a crew.

The boss bar shows the live damage split in each player's color.

## Content

- **7 blasters:** single shot, triple spread, rapid, homing, explosive, piercing, chain lightning.
- **7 upgrades:** fire rate, damage, range, crit chance, shot speed, coin bonus, XP bonus.
- **12 fish types:** splitters, armored fish, golden fish, critical fish that trigger chain lightning, revenants that come back as skeletons, and eels.
- **5 zones:** each has its own sky, seabed and boss. Queen Puff summons fish, The Ossified raises a shield, Rift Eel teleports, and Starfall Leviathan enrages. After zone 5 the loop restarts harder.
- **6 events:** Frenzy, Golden Rush, Giant Hunt, Speed Tide, Swarm, Bounty Wave.
- **12 captains** (cosmetic) and **8 boats with passive buffs** that stack with your upgrade picks. The two free boats give +15% range (Rowboat) or +10% coins (Trawler). The top one, Ghost Ship (10,000 coins), gives +30% damage, +20% fire rate and +10% crit chance. Coin and XP buffs multiply your own share after the split, so they never take loot from teammates.

## Weapon balance

Every blaster does more damage per second than the cheaper ones, and its specialty comes on top. `go test -run Efficiency -v .` measures this in the actual simulation, so misses, splash, pierce and chains all count. Damage delivered by a bot with no upgrades:

| Blaster | Cost | Delivered DPS |
|---|---|---|
| Deck Popper | 0 | ~45 |
| Tri-Spreader | 600 | ~65 |
| Riptide SMG | 1,500 | ~71 |
| Seeker | 3,000 | ~80 |
| Depth Charger | 5,000 | ~100 (more against groups) |
| Harpoon Rifle | 8,000 | ~150 |
| Storm Coil | 12,000 | ~185 |

In normal play with killable fish, the Storm Coil gets about 2.1× the starter's kills. It isn't the full 4×, because fish supply is finite. That test fails if the gap ever drops below 1.6×.

## Redeem codes and god mode

Codes live in `server-config.json` and are checked on the server. Each account can use each code once. The shipped codes are `welcome`, `kraken` and `admin`.

**Change or remove `admin` before you let anyone else play.** It unlocks god mode, which works like this:
- It gives max upgrades and all blasters, but only while you are alone in the room.
- It earns no coins or XP, so you can't farm coins solo and bring stronger weapons into co-op.
- It switches off automatically when a second player joins.

Restart the server after editing the config.

## Known limits

- Storage is a single JSON file held in memory. That's fine for a group of friends; it is not built for many concurrent players.
- Passwords are hashed (PBKDF2-SHA256), but the server speaks plain HTTP. Put it behind HTTPS if it's reachable from the internet.
- The display fonts load from Google Fonts. Without internet access the UI falls back to system fonts.
- Server snapshots are 15 Hz with client smoothing. It plays well on LAN and normal internet connections, but high latency will show as delayed hits.
- A player who disconnects loses their spot in the room. Their progress up to the last catch is saved.

## Credits

All art is by Kenney (www.kenney.nl), CC0: Watercraft, Blaster Kit, Fantasy Town Kit, Mini Characters, Fish Pack, Board Game Icons, and Skyboxes. The license files are in `licenses/`. Three.js is MIT licensed.
