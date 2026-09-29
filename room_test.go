package main

import (
	"math"
	"testing"
)

func newTestRoom(t *testing.T, n int) (*Room, []*Player) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(store, Config{})
	r := NewRoom(hub, "TEST1")
	var ps []*Player
	for i := 0; i < n; i++ {
		prof, _ := store.Register("bot"+itoa(i), "password")
		c := &Client{hub: hub, prof: prof, send: make(chan []byte, 1<<16), done: make(chan struct{})}
		go func() {
			for range c.send {
			}
		}()
		p, err := r.addPlayer(c)
		if err != nil {
			t.Fatal(err)
		}
		c.player, c.room = p, r
		ps = append(ps, p)
	}
	return r, ps
}

// bots aim at the nearest fish and always fire
func driveBots(r *Room, ps []*Player) {
	for _, p := range ps {
		var best *FishE
		bd := 1e9
		for _, f := range r.fish {
			if !r.hittable(f) || f.x < FieldMinX || f.x > FieldMaxX {
				continue
			}
			d := math.Hypot(f.x-r.boatX(p.slot), f.z-BoatZ)
			if f.def.Boss {
				d -= 100
			}
			if d < bd {
				bd, best = d, f
			}
		}
		p.firing = best != nil
		if best != nil {
			p.aimX, p.aimZ = best.x+best.dir*0.8, best.z
		}
		// spend skill picks automatically
		if len(p.offer) > 0 {
			r.pickSkill(p, p.offer[0])
		}
	}
}

func TestLootSplitConservesCoins(t *testing.T) {
	r, ps := newTestRoom(t, 3)
	dt := 1.0 / TickRate
	kills, multi := 0, 0
	for i := 0; i < TickRate*240; i++ {
		driveBots(r, ps)
		r.step(dt)
		for _, e := range r.events {
			m, ok := e.(map[string]any)
			if !ok || m["k"] != "k" {
				continue
			}
			loot := m["loot"].([][]float64)
			kills++
			if len(loot) > 1 {
				multi++
			}
			pct := 0.0
			for _, l := range loot {
				pct += l[2]
			}
			if len(loot) > 0 && (pct < 97 || pct > 103) {
				t.Fatalf("shares don't add to 100%%: %v", loot)
			}
		}
		r.events = nil
	}
	if kills == 0 {
		t.Fatal("no kills")
	}
	t.Logf("kills=%d shared=%d zone=%d loop=%d phase=%s", kills, multi, r.zone, r.loop, r.phase)
	for _, p := range ps {
		t.Logf("%s: coins=%d dmg=%.0f kills=%d lvl=%d score=%.0f", p.prof.Name, p.coins, p.dmg, p.kills, p.prof.Level, p.score)
	}
}

func TestLargestRemainder(t *testing.T) {
	r, ps := newTestRoom(t, 3)
	f := r.spawnFish(fishIndex["golden"], 0, 0)
	f.x, f.z = 0, 0
	// uneven damage: 1/3 each would lose a coin with naive rounding
	each := f.hp / 3
	r.damage(f, ps[0], each, 0, 0)
	r.damage(f, ps[1], each, 0, 0)
	r.damage(f, ps[2], each*1.5, 0, 0) // overkill must not inflate share
	var loot [][]float64
	for _, e := range r.events {
		if m, ok := e.(map[string]any); ok && m["k"] == "k" {
			loot = m["loot"].([][]float64)
		}
	}
	sum := 0.0
	for _, l := range loot {
		sum += l[1]
	}
	want := math.Round(Fish[fishIndex["golden"]].Coins * CoinScale * r.zdef().Diff * r.pScale())
	if sum != want {
		t.Fatalf("coins not conserved: got %v want %v (%v)", sum, want, loot)
	}
	if loot[2][2] != 33 && loot[2][2] != 34 {
		t.Fatalf("overkill inflated share: %v", loot)
	}
}

func TestSoloPacing(t *testing.T) {
	r, ps := newTestRoom(t, 1)
	dt := 1.0 / TickRate
	bossAt, clearAt := -1.0, -1.0
	for i := 0; i < TickRate*600; i++ {
		driveBots(r, ps)
		r.step(dt)
		sec := float64(i) / TickRate
		if r.phase == "boss" && bossAt < 0 {
			bossAt = sec
		}
		if r.phase == "clear" && clearAt < 0 {
			clearAt = sec
		}
		r.events = nil
	}
	t.Logf("solo: boss at %.0fs, first clear at %.0fs, zone=%d, level=%d coins=%d", bossAt, clearAt, r.zone, ps[0].prof.Level, ps[0].coins)
}

// Each weapon, fired by the same bot for 2 minutes of real play, should out-
// damage every cheaper weapon. This measures delivered damage, so misses,
// splash, pierce and chains all count.
func TestWeaponEfficiencyScalesWithPrice(t *testing.T) {
	dt := 1.0 / TickRate
	prev := 0.0
	for _, w := range Weapons {
		total := 0.0
		for seed := 0; seed < 3; seed++ {
			r, ps := newTestRoom(t, 1)
			r.rng.Seed(int64(seed + 1))
			p := ps[0]
			p.prof.Weapons = append(p.prof.Weapons, w.ID)
			p.prof.Weapon = w.ID
			for i := 0; i < TickRate*120; i++ {
				driveBots(r, ps)
				p.offer = nil              // no upgrades: compare raw weapons
				for _, f := range r.fish { // unkillable targets: measure the weapon, not the fish supply
					if f.maxHP < 1e6 {
						f.hp, f.maxHP = 1e7, 1e7
					}
				}
				r.step(dt)
				r.events = nil
			}
			total += p.dmg
		}
		dps := total / 3 / 120
		t.Logf("%-14s cost %6d  delivered dps %6.1f", w.Name, w.Cost, dps)
		if dps < prev*0.97 {
			t.Errorf("%s (cost %d) delivers less than a cheaper weapon: %.1f < %.1f", w.Name, w.Cost, dps, prev)
		}
		if dps > prev {
			prev = dps
		}
	}
}

// Same comparison with normal, killable fish: better weapons must still earn
// more, i.e. fish supply must not flatten the upgrade curve.
func TestWeaponUpgradeFeltInRealPlay(t *testing.T) {
	dt := 1.0 / TickRate
	var basicKills, bestKills float64
	for _, id := range []string{"basic", "tesla"} {
		total := 0
		for seed := 0; seed < 3; seed++ {
			r, ps := newTestRoom(t, 1)
			r.rng.Seed(int64(seed + 1))
			p := ps[0]
			p.prof.Weapons = append(p.prof.Weapons, id)
			p.prof.Weapon = id
			for i := 0; i < TickRate*120; i++ {
				driveBots(r, ps)
				p.offer = nil
				r.step(dt)
				r.events = nil
			}
			total += p.kills
		}
		k := float64(total) / 3
		t.Logf("%s: %.0f kills in 2 min", id, k)
		if id == "basic" {
			basicKills = k
		} else {
			bestKills = k
		}
	}
	if bestKills < basicKills*1.6 {
		t.Errorf("Storm Coil should clearly out-kill the starter: %.0f vs %.0f", bestKills, basicKills)
	}
}
