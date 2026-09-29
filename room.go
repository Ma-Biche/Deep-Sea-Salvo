package main

import (
	"encoding/json"
	"errors"
	"math"
	"math/rand"
	"sort"
	"sync"
	"time"
)

// World layout (world units). Fish swim in the XZ plane at depth FishY.
const (
	FieldMinX = -17.0
	FieldMaxX = 17.0
	FieldMinZ = -11.0
	FieldMaxZ = 4.5
	BoatZ     = 8.2
	FishY     = -1.7
	BaseRange = 24.0

	TickRate      = 30
	SnapshotEvery = 2 // 15 Hz snapshots
	MaxPlayers    = 4
)

var SlotX = []float64{-10.5, -3.5, 3.5, 10.5}

type Player struct {
	client     *Client
	slot       int
	prof       *Profile
	aimX       float64
	aimZ       float64
	firing     bool
	cooldown   float64
	combo      int
	comboT     float64
	bestCombo  int
	score      float64
	kills      int
	dmg        float64
	coins      int
	xp         float64
	offer      []string
	profDirty  bool
	joined     time.Time
	pendingDmg float64
}

type FishE struct {
	id      int
	def     *FishDef
	ty      int
	x, z    float64
	z0      float64
	dir     float64
	t       float64
	phase   float64
	zz      float64
	zzT     float64
	hp      float64
	maxHP   float64
	armor   float64
	dmg     map[int]float64 // player slot -> credited damage
	dead    bool
	gone    bool
	fleeing bool
	flags   int
	spT     float64 // special timer
	stT     float64 // state timer (shield / hidden)
	enraged bool
}

type Bullet struct {
	id     int
	slot   int
	w      int
	x, z   float64
	vx, vz float64
	speed  float64
	dmg    float64
	crit   float64
	life   float64
	pierce int
	hit    map[int]bool
	target int
	retgt  float64
}

type Room struct {
	mu          sync.Mutex
	hub         *Hub
	code        string
	players     [MaxPlayers]*Player
	fish        []*FishE
	bullets     []*Bullet
	nextID      int
	tick        int
	rng         *rand.Rand
	events      []any
	quit        chan struct{}
	stopOnce    sync.Once
	closed      bool
	rosterDirty bool
	rosterT     float64

	zone     int
	loop     int
	progress float64
	phase    string // play | warn | boss | clear
	phaseT   float64
	bossID   int
	bossT    float64

	evt    *EventDef
	evtT   float64
	evtCD  float64
	spawnT float64
	swarmT float64
}

func NewRoom(h *Hub, code string) *Room {
	return &Room{hub: h, code: code, rng: rand.New(rand.NewSource(time.Now().UnixNano())),
		quit: make(chan struct{}), phase: "play", evtCD: 35, nextID: 1}
}

func (r *Room) stop() { r.stopOnce.Do(func() { close(r.quit) }) }

func (r *Room) count() int {
	n := 0
	for _, p := range r.players {
		if p != nil {
			n++
		}
	}
	return n
}

func (r *Room) godActive(prof *Profile) bool {
	return prof.God && prof.GodOn && r.count() == 1
}

func (r *Room) addPlayer(c *Client) (*Player, error) {
	if r.closed {
		return nil, errors.New("That room just closed. Create a new one.")
	}
	for i := 0; i < MaxPlayers; i++ {
		if r.players[i] == nil {
			p := &Player{client: c, slot: i, prof: c.prof, aimX: 0, aimZ: -3, joined: time.Now()}
			r.players[i] = p
			r.rosterDirty = true
			p.profDirty = true
			if c.prof.Picks > 0 {
				r.makeOffer(p)
			}
			r.emit(map[string]any{"k": "join", "s": i, "n": c.prof.Name})
			c.sendJSON(map[string]any{"t": "joined", "code": r.code, "slot": i})
			return p, nil
		}
	}
	return nil, errors.New("That room is full (4 players).")
}

func (r *Room) removePlayer(p *Player) map[string]any {
	if p == nil || r.players[p.slot] != p {
		return nil
	}
	r.commit(p)
	r.players[p.slot] = nil
	r.rosterDirty = true
	for _, f := range r.fish {
		delete(f.dmg, p.slot) // their share is redistributed to whoever finishes the fish
	}
	kept := r.bullets[:0]
	for _, b := range r.bullets {
		if b.slot != p.slot {
			kept = append(kept, b)
		}
	}
	r.bullets = kept
	r.emit(map[string]any{"k": "leave", "s": p.slot, "n": p.prof.Name})
	if r.count() == 0 {
		r.closed = true
	}
	return map[string]any{
		"score": int(p.score), "kills": p.kills, "damage": math.Round(p.dmg), "coins": p.coins,
		"xp": int(p.xp), "bestCombo": p.bestCombo, "minutes": time.Since(p.joined).Minutes(),
	}
}

// commit flushes session stats that are tracked lazily.
func (r *Room) commit(p *Player) {
	s := r.hub.store
	d := p.pendingDmg
	p.pendingDmg = 0
	s.Mutate(func() {
		p.prof.Damage += d
		if int(p.score) > p.prof.Best {
			p.prof.Best = int(p.score)
		}
		if p.bestCombo > p.prof.BestCombo {
			p.prof.BestCombo = p.bestCombo
		}
	})
}

func (r *Room) emit(e any) { r.events = append(r.events, e) }

func (r *Room) newID() int { r.nextID++; return r.nextID }

// effective skill value, honouring solo god mode.
// Upgrade picks plus the equipped boat's buff (god mode: maxed picks).
func (r *Room) skill(p *Player, id string) float64 {
	base := p.prof.Skills[id]
	if r.godActive(p.prof) {
		base = Skills[skillIndex[id]].Max
	}
	return base + boatBuff(p.prof.Boat, id)
}

func (r *Room) weaponOf(p *Player) int {
	i := weaponIndex[p.prof.Weapon]
	if !p.prof.has(p.prof.Weapons, p.prof.Weapon) && !r.godActive(p.prof) {
		return 0
	}
	return i
}

// boatX spreads boats evenly for however many captains are present, so a
// solo player sits in the middle instead of at the far left.
func (r *Room) boatX(slot int) float64 {
	layouts := [][]float64{{0}, {-5, 5}, {-9, 0, 9}, {-10.5, -3.5, 3.5, 10.5}}
	n, rank := 0, 0
	for i, p := range r.players {
		if p != nil {
			if i < slot {
				rank++
			}
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return layouts[n-1][rank]
}

func (r *Room) pScale() float64   { return 1 + 0.65*float64(r.count()-1) }
func (r *Room) loopMult() float64 { return math.Pow(1.4, float64(r.loop)) }
func (r *Room) zdef() *ZoneDef    { return &Zones[r.zone] }

// devProgressScale shortens zones when the server runs with -dev.
var devProgressScale = 1.0

func (r *Room) progressNeeded() float64 {
	n := float64(max(1, r.count()))
	return devProgressScale * 4200 * (0.6 + 0.4*n) * (1 + 0.15*float64(r.zone)) * (1 + 0.25*float64(r.loop))
}

// ---------------- main loop ----------------

func (r *Room) run() {
	t := time.NewTicker(time.Second / TickRate)
	defer t.Stop()
	dt := 1.0 / TickRate
	for {
		select {
		case <-r.quit:
			return
		case <-t.C:
			r.mu.Lock()
			r.step(dt)
			var snap []byte
			if r.tick%SnapshotEvery == 0 {
				snap = r.snapshot()
			}
			var roster []byte
			r.rosterT -= dt
			if r.rosterDirty || r.rosterT <= 0 {
				roster = r.roster()
				r.rosterDirty = false
				r.rosterT = 1
			}
			type direct struct {
				c *Client
				b []byte
			}
			var directs []direct
			var clients []*Client
			for _, p := range r.players {
				if p == nil {
					continue
				}
				clients = append(clients, p.client)
				if p.profDirty {
					p.profDirty = false
					b, _ := json.Marshal(map[string]any{"t": "me", "me": p.prof.View(), "god": r.godActive(p.prof)})
					directs = append(directs, direct{p.client, b})
				}
			}
			r.mu.Unlock()
			for _, c := range clients {
				if roster != nil {
					c.sendRaw(roster, false)
				}
				if snap != nil {
					c.sendRaw(snap, true)
				}
			}
			for _, d := range directs {
				d.c.sendRaw(d.b, false)
			}
		}
	}
}

func (r *Room) roster() []byte {
	list := []map[string]any{}
	for _, p := range r.players {
		if p == nil {
			continue
		}
		list = append(list, map[string]any{
			"slot": p.slot, "name": p.prof.Name, "level": p.prof.Level, "boat": p.prof.Boat, "char": p.prof.Char,
			"color": PlayerColors[p.slot], "score": int(p.score), "kills": p.kills, "dmg": math.Round(p.dmg),
			"coins": p.coins, "god": r.godActive(p.prof), "w": r.weaponOf(p), "x": r.boatX(p.slot),
		})
	}
	b, _ := json.Marshal(map[string]any{"t": "room", "code": r.code, "players": list})
	return b
}

func r2(v float64) float64 { return math.Round(v*100) / 100 }

func (r *Room) snapshot() []byte {
	fl := make([][]float64, 0, len(r.fish))
	for _, f := range r.fish {
		if f.gone {
			continue
		}
		fl = append(fl, []float64{float64(f.id), float64(f.ty), r2(f.x), r2(f.z), math.Round(1000 * f.hp / f.maxHP), float64(f.flags), f.dir})
	}
	bl := make([][]float64, 0, len(r.bullets))
	for _, b := range r.bullets {
		bl = append(bl, []float64{float64(b.id), float64(b.slot), r2(b.x), r2(b.z), float64(b.w)})
	}
	pl := [][]float64{}
	for _, p := range r.players {
		if p == nil {
			continue
		}
		fire := 0.0
		if p.firing {
			fire = 1
		}
		pl = append(pl, []float64{float64(p.slot), r2(p.aimX), r2(p.aimZ), fire, float64(p.combo), float64(r.weaponOf(p))})
	}
	st := map[string]any{"z": r.zone, "lp": r.loop, "pr": math.Round(1000 * math.Min(1, r.progress/r.progressNeeded())), "ph": r.phase}
	if r.evt != nil {
		st["ev"] = []any{r.evt.ID, math.Ceil(r.evtT)}
	}
	for _, f := range r.fish {
		if f.def.Boss && !f.dead && !f.gone {
			total := 0.0
			for _, d := range f.dmg {
				total += d
			}
			share := [][]float64{}
			for s, d := range f.dmg {
				share = append(share, []float64{float64(s), math.Round(d / f.maxHP * 1000)})
			}
			sort.Slice(share, func(i, j int) bool { return share[i][0] < share[j][0] })
			st["boss"] = map[string]any{"id": f.id, "ty": f.ty, "hp": math.Round(1000 * f.hp / f.maxHP), "share": share}
			break
		}
	}
	msg := map[string]any{"t": "s", "tk": r.tick, "f": fl, "b": bl, "p": pl, "st": st}
	if len(r.events) > 0 {
		msg["ev"] = r.events
		r.events = nil
	}
	b, _ := json.Marshal(msg)
	return b
}

func (r *Room) step(dt float64) {
	r.tick++
	if r.count() == 0 {
		return
	}
	r.updatePhase(dt)
	r.updateEvents(dt)
	r.spawn(dt)
	r.updatePlayers(dt)
	r.updateFish(dt)
	r.updateBullets(dt)
	// cleanup
	keep := r.fish[:0]
	for _, f := range r.fish {
		if !f.dead && !f.gone {
			keep = append(keep, f)
		}
	}
	r.fish = keep
	// periodic commit of lazy stats
	if r.tick%(TickRate*10) == 0 {
		for _, p := range r.players {
			if p != nil {
				r.commit(p)
			}
		}
	}
}

// ---------------- zone / boss flow ----------------

func (r *Room) updatePhase(dt float64) {
	r.phaseT += dt
	switch r.phase {
	case "play":
		if r.progress >= r.progressNeeded() {
			r.phase, r.phaseT = "warn", 0
			r.endEvent()
			r.emit(map[string]any{"k": "bossWarn", "ty": fishIndex[r.zdef().Boss]})
		}
	case "warn":
		if r.phaseT > 3.5 {
			r.phase, r.phaseT = "boss", 0
			f := r.spawnFish(fishIndex[r.zdef().Boss], 0, 0)
			f.x = -f.dir * (FieldMaxX + 4)
			f.z0, f.z = -3.5, -3.5
			r.bossID = f.id
			r.bossT = 0
		}
	case "boss":
		r.bossT += dt
		alive := false
		for _, f := range r.fish {
			if f.id == r.bossID && !f.dead && !f.gone {
				alive = true
				if r.bossT > 110 && !f.fleeing {
					f.fleeing = true
					r.emit(map[string]any{"k": "bossFlee", "ty": f.ty})
				}
			}
		}
		if !alive && r.phaseT > 1 {
			// either killed (handled in kill) or escaped
			if r.phase == "boss" {
				r.phase, r.phaseT = "play", 0
				r.progress = r.progressNeeded() * 0.5
			}
		}
	case "clear":
		if r.phaseT > 5 {
			r.zone++
			if r.zone >= len(Zones) {
				r.zone = 0
				r.loop++
			}
			r.progress = 0
			r.phase, r.phaseT = "play", 0
			r.evtCD = 30
			r.emit(map[string]any{"k": "zone", "z": r.zone, "lp": r.loop})
		}
	}
}

func (r *Room) bossDefeated(f *FishE) {
	r.phase, r.phaseT = "clear", 0
	for _, o := range r.fish {
		if o != f {
			o.gone = true
		}
	}
	r.bullets = r.bullets[:0]
	bonus := int(120 * r.zdef().Diff * r.loopMult())
	for _, p := range r.players {
		if p == nil || r.godActive(p.prof) {
			continue
		}
		pp := p
		r.hub.store.Mutate(func() { pp.prof.Coins += bonus; pp.prof.Lifetime += bonus })
		p.coins += bonus
		p.profDirty = true
	}
	r.emit(map[string]any{"k": "clear", "ty": f.ty, "bonus": bonus, "next": Zones[(r.zone+1)%len(Zones)].Name})
}

// ---------------- events ----------------

func (r *Room) updateEvents(dt float64) {
	if r.evt != nil {
		r.evtT -= dt
		if r.evt.ID == "swarm" {
			r.swarmT -= dt
			if r.swarmT <= 0 {
				r.swarmT = 2.2
				r.spawnSchool()
			}
		}
		if r.evtT <= 0 {
			r.endEvent()
		}
		return
	}
	if r.phase != "play" {
		return
	}
	r.evtCD -= dt
	if r.evtCD <= 0 {
		e := &Events[r.rng.Intn(len(Events))]
		r.evt, r.evtT = e, e.Duration
		r.emit(map[string]any{"k": "event", "id": e.ID})
		if e.ID == "giant" {
			f := r.spawnFish(fishIndex["giant"], 0, 0)
			f.z0, f.z = -2, -2
		}
		r.swarmT = 0
	}
}

func (r *Room) endEvent() {
	if r.evt == nil {
		return
	}
	r.emit(map[string]any{"k": "eventEnd", "id": r.evt.ID})
	r.evt = nil
	r.evtCD = 40 + r.rng.Float64()*25
}

func (r *Room) evtIs(id string) bool { return r.evt != nil && r.evt.ID == id }

func (r *Room) coinMult() float64 {
	switch {
	case r.evtIs("speed"):
		return 1.3
	case r.evtIs("bounty"):
		return 2
	}
	return 1
}

// ---------------- spawning ----------------

func (r *Room) pickType() int {
	w := r.zdef().Weights
	if r.evtIs("golden") && r.rng.Float64() < 0.4 {
		return fishIndex["golden"]
	}
	if r.evtIs("bounty") && r.rng.Float64() < 0.45 {
		if r.rng.Float64() < 0.5 {
			return fishIndex["tank"]
		}
		return fishIndex["armored"]
	}
	keys := make([]string, 0, len(w))
	for k := range w {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	total := 0
	for _, k := range keys {
		total += w[k]
	}
	n := r.rng.Intn(total)
	for _, k := range keys {
		n -= w[k]
		if n < 0 {
			return fishIndex[k]
		}
	}
	return 0
}

func (r *Room) spawn(dt float64) {
	if r.phase == "warn" || r.phase == "clear" {
		return
	}
	n := r.count()
	maxF := 12 + 2*r.zone + 4*(n-1)
	if maxF > 38 {
		maxF = 38
	}
	if r.evtIs("frenzy") || r.evtIs("bounty") || r.evtIs("swarm") {
		maxF = int(float64(maxF) * 1.7)
		if maxF > 46 {
			maxF = 46
		}
	}
	if r.phase == "boss" {
		maxF /= 2
	}
	if len(r.fish) >= maxF {
		return
	}
	delay := math.Max(0.1, 0.8-0.08*float64(maxF-len(r.fish)))
	if r.evtIs("frenzy") {
		delay = 0.06
	}
	r.spawnT += dt
	if r.spawnT >= delay {
		r.spawnT = 0
		r.spawnFish(r.pickType(), 0, 0)
	}
}

func (r *Room) spawnSchool() {
	dir := 1.0
	if r.rng.Intn(2) == 0 {
		dir = -1
	}
	cz := FieldMinZ + 2 + r.rng.Float64()*(FieldMaxZ-FieldMinZ-4)
	for i := 0; i < 7; i++ {
		f := r.spawnFish(fishIndex["small"], 0, 0)
		f.dir = dir
		f.x = -dir*(FieldMaxX+2) - dir*float64(i%3)*1.2
		f.z0 = cz + float64(i/3-1)*1.1 + r.rng.Float64()*0.3
		f.z = f.z0
		f.phase = 0
	}
}

func (r *Room) spawnFish(ty int, x, z float64) *FishE {
	d := &Fish[ty]
	f := &FishE{id: r.newID(), def: d, ty: ty, dmg: map[int]float64{}, phase: r.rng.Float64() * 6.28}
	f.dir = 1
	if r.rng.Intn(2) == 0 {
		f.dir = -1
	}
	if x == 0 && z == 0 {
		f.x = -f.dir * (FieldMaxX + 2)
		f.z = FieldMinZ + 1 + r.rng.Float64()*(FieldMaxZ-FieldMinZ-1.5)
	} else {
		f.x, f.z = x, z
	}
	f.z0 = f.z
	hp := d.HP * r.zdef().Diff * r.loopMult() * r.pScale()
	f.hp, f.maxHP = hp, hp
	f.armor = d.Armor
	f.zz = 1
	f.spT = 4
	r.fish = append(r.fish, f)
	return f
}

// ---------------- players / firing ----------------

func (r *Room) updatePlayers(dt float64) {
	for _, p := range r.players {
		if p == nil {
			continue
		}
		if p.comboT > 0 {
			p.comboT -= dt
			if p.comboT <= 0 {
				p.combo = 0
			}
		}
		if p.cooldown > 0 {
			p.cooldown -= dt
		}
		if !p.firing || r.phase == "clear" {
			if p.cooldown < 0 {
				p.cooldown = 0
			}
			continue
		}
		wi := r.weaponOf(p)
		w := &Weapons[wi]
		rate := w.FireRate / 1000 / (1 + r.skill(p, "attackSpeed"))
		for p.cooldown <= 0 {
			r.fire(p, wi)
			p.cooldown += rate
		}
	}
}

func (r *Room) fire(p *Player, wi int) {
	w := &Weapons[wi]
	ox, oz := r.boatX(p.slot), BoatZ-0.9
	dx, dz := p.aimX-ox, p.aimZ-oz
	if dz > -0.4 {
		dz = -0.4
	}
	base := math.Atan2(dz, dx)
	speed := w.Speed * (1 + r.skill(p, "projectileSpeed"))
	dmg := w.Damage * (1 + r.skill(p, "damage"))
	rangeU := BaseRange * (1 + r.skill(p, "range"))
	crit := r.skill(p, "critChance")
	angles := []float64{0}
	if w.Kind == "spread" {
		angles = []float64{-0.14, 0, 0.14}
	}
	for _, a := range angles {
		b := &Bullet{id: r.newID(), slot: p.slot, w: wi, x: ox, z: oz, speed: speed, dmg: dmg, crit: crit,
			life: rangeU / speed, pierce: w.Pierce, target: -1}
		b.vx, b.vz = math.Cos(base+a)*speed, math.Sin(base+a)*speed
		if w.Kind == "pierce" {
			b.hit = map[int]bool{}
		}
		r.bullets = append(r.bullets, b)
	}
}

// ---------------- fish movement ----------------

func (r *Room) updateFish(dt float64) {
	speedMult := 1 + 0.04*float64(r.zone)
	if r.evtIs("speed") {
		speedMult *= 1.7
	}
	for _, f := range r.fish {
		if f.dead || f.gone {
			continue
		}
		d := f.def
		f.t += dt
		s := d.Speed * speedMult
		if f.enraged {
			s *= 1.8
		}
		if f.fleeing && !d.Boss {
			s *= 3
		}
		prevZ := f.z
		switch d.Move {
		case "straight":
			f.x += f.dir * s * dt
			f.z = f.z0 + 0.4*math.Sin(f.t*0.8+f.phase)
		case "sine":
			f.x += f.dir * s * dt
			f.z = f.z0 + 1.5*math.Sin(f.t*1.8+f.phase)
		case "zigzag":
			f.x += f.dir * s * 0.9 * dt
			f.zzT -= dt
			if f.zzT <= 0 {
				f.zz = -f.zz
				f.zzT = 0.5 + r.rng.Float64()*0.5
			}
			f.z += f.zz * s * 0.7 * dt
			f.z0 = f.z
		case "burst":
			f.x += f.dir * s * (0.35 + 1.4*math.Max(0, math.Sin(f.t*3+f.phase))) * dt
			f.z = f.z0 + 0.3*math.Sin(f.t*1.3+f.phase)
		case "slow_curve":
			f.x += f.dir * s * dt
			f.z = f.z0 + 3*math.Sin(f.t*0.5+f.phase)
		case "boss":
			f.x += f.dir * s * dt
			if !f.fleeing {
				if f.dir > 0 && f.x > FieldMaxX-4 {
					f.dir = -1
				} else if f.dir < 0 && f.x < FieldMinX+4 {
					f.dir = 1
				}
			}
			f.z = f.z0 + 3*math.Sin(f.t*0.35)
			r.bossSpecial(f, dt)
		}
		// keep inside the field vertically
		if f.z < FieldMinZ+0.5 {
			f.z = FieldMinZ + 0.5
			f.zz = 1
			f.z0 += 0.5
		} else if f.z > FieldMaxZ {
			f.z = FieldMaxZ
			f.zz = -1
			f.z0 -= 0.5
		}
		_ = prevZ
		// escaped?
		if (f.dir > 0 && f.x > FieldMaxX+4) || (f.dir < 0 && f.x < FieldMinX-4) {
			if !d.Boss || f.fleeing || f.id != r.bossID {
				f.gone = true
				if d.Boss {
					r.emit(map[string]any{"k": "escaped", "ty": f.ty})
				}
			}
		}
	}
}

func (r *Room) bossSpecial(f *FishE, dt float64) {
	f.spT -= dt
	if f.stT > 0 {
		f.stT -= dt
		if f.stT <= 0 {
			f.flags &^= 3
			f.armor = f.def.Armor
		}
	}
	switch f.def.Special {
	case "summon":
		if f.spT <= 0 {
			f.spT = 7
			for i := 0; i < 3; i++ {
				c := r.spawnFish(fishIndex["small"], f.x+(r.rng.Float64()-0.5)*3, f.z+(r.rng.Float64()-0.5)*3)
				c.dir = f.dir
			}
			r.emit(map[string]any{"k": "fx", "fx": "summon", "x": r2(f.x), "z": r2(f.z)})
		}
	case "armor":
		if f.spT <= 0 {
			f.spT = 10
			f.stT = 3
			f.armor = 0.8
			f.flags |= 1
		}
	case "blink":
		if f.spT <= 0 {
			f.spT = 6
			f.stT = 0.8
			f.flags |= 2
			f.x = FieldMinX + 5 + r.rng.Float64()*(FieldMaxX-FieldMinX-10)
			f.z0 = FieldMinZ + 3 + r.rng.Float64()*(FieldMaxZ-FieldMinZ-5)
			r.emit(map[string]any{"k": "fx", "fx": "blink", "x": r2(f.x), "z": r2(f.z0)})
		}
	case "enrage":
		if !f.enraged && f.hp < f.maxHP*0.5 {
			f.enraged = true
			f.flags |= 4
			r.emit(map[string]any{"k": "fx", "fx": "enrage", "x": r2(f.x), "z": r2(f.z)})
		}
		if f.enraged && f.spT <= 0 {
			f.spT = 9
			r.spawnFish(fishIndex["critical"], 0, 0)
		}
	}
}

// ---------------- bullets & collisions ----------------

// distance from point to fish capsule (segment along x axis)
func fishDist(f *FishE, x, z float64) float64 {
	hl := f.def.HalfLen
	dx := x - f.x
	if dx > hl {
		dx -= hl
	} else if dx < -hl {
		dx += hl
	} else {
		dx = 0
	}
	dz := z - f.z
	return math.Sqrt(dx*dx+dz*dz) - f.def.Radius
}

func (r *Room) hittable(f *FishE) bool {
	return !f.dead && !f.gone && f.flags&2 == 0 && f.x > FieldMinX-3 && f.x < FieldMaxX+3
}

func (r *Room) updateBullets(dt float64) {
	keep := r.bullets[:0]
	for _, b := range r.bullets {
		alive := true
		p := r.players[b.slot]
		if p == nil {
			continue
		}
		w := &Weapons[b.w]
		steps := int(math.Ceil(b.speed * dt / 0.35))
		sdt := dt / float64(steps)
		for s := 0; s < steps && alive; s++ {
			if w.Kind == "homing" {
				r.steer(b, sdt)
			}
			b.x += b.vx * sdt
			b.z += b.vz * sdt
			b.life -= sdt
			if b.life <= 0 || b.x < FieldMinX-6 || b.x > FieldMaxX+6 || b.z < FieldMinZ-3 || b.z > BoatZ+1 {
				alive = false
				break
			}
			for _, f := range r.fish {
				if !r.hittable(f) || fishDist(f, b.x, b.z) > 0.15 {
					continue
				}
				if b.hit != nil && b.hit[f.id] {
					continue
				}
				switch w.Kind {
				case "explosive":
					r.explode(p, b)
					alive = false
				case "pierce":
					b.hit[f.id] = true
					r.damage(f, p, b.dmg, b.crit, b.w)
					b.pierce--
					if b.pierce <= 0 {
						alive = false
					}
				case "chain":
					r.damage(f, p, b.dmg, b.crit, b.w)
					r.chainFrom(f, p, b.dmg*0.7, w.Chain, 5.5, b.w)
					alive = false
				default:
					r.damage(f, p, b.dmg, b.crit, b.w)
					alive = false
				}
				if !alive {
					break
				}
			}
		}
		if alive {
			keep = append(keep, b)
		}
	}
	r.bullets = keep
	if r.phase == "clear" {
		r.bullets = r.bullets[:0]
	}
}

func (r *Room) steer(b *Bullet, dt float64) {
	b.retgt -= dt
	var tgt *FishE
	if b.target >= 0 {
		for _, f := range r.fish {
			if f.id == b.target && r.hittable(f) {
				tgt = f
				break
			}
		}
	}
	if tgt == nil || b.retgt <= 0 {
		b.retgt = 0.25
		best := 14.0
		tgt = nil
		for _, f := range r.fish {
			if !r.hittable(f) {
				continue
			}
			d := math.Hypot(f.x-b.x, f.z-b.z)
			// prefer targets roughly ahead
			if (f.x-b.x)*b.vx+(f.z-b.z)*b.vz < 0 {
				d *= 2
			}
			if d < best {
				best, tgt = d, f
			}
		}
		if tgt != nil {
			b.target = tgt.id
		}
	}
	if tgt == nil {
		return
	}
	cur := math.Atan2(b.vz, b.vx)
	want := math.Atan2(tgt.z-b.z, tgt.x-b.x)
	diff := math.Remainder(want-cur, 2*math.Pi)
	turn := 5.0 * dt
	if diff > turn {
		diff = turn
	} else if diff < -turn {
		diff = -turn
	}
	cur += diff
	b.vx, b.vz = math.Cos(cur)*b.speed, math.Sin(cur)*b.speed
}

func (r *Room) explode(p *Player, b *Bullet) {
	rad := Weapons[b.w].Radius
	r.emit(map[string]any{"k": "boom", "x": r2(b.x), "z": r2(b.z), "r": rad, "s": p.slot})
	for _, f := range r.fish {
		if !r.hittable(f) {
			continue
		}
		d := fishDist(f, b.x, b.z)
		if d <= rad {
			fall := 1 - 0.5*math.Max(0, d)/rad
			r.damage(f, p, b.dmg*fall, b.crit, b.w)
		}
	}
}

func (r *Room) chainFrom(src *FishE, p *Player, dmg float64, n int, reach float64, wi int) {
	pts := [][]float64{{r2(src.x), r2(src.z)}}
	used := map[int]bool{src.id: true}
	cur := src
	for i := 0; i < n; i++ {
		var best *FishE
		bd := reach
		for _, f := range r.fish {
			if used[f.id] || !r.hittable(f) {
				continue
			}
			d := math.Hypot(f.x-cur.x, f.z-cur.z)
			if d < bd {
				bd, best = d, f
			}
		}
		if best == nil {
			break
		}
		used[best.id] = true
		pts = append(pts, []float64{r2(best.x), r2(best.z)})
		r.damage(best, p, dmg, 0, wi)
		cur = best
	}
	if len(pts) > 1 {
		r.emit(map[string]any{"k": "zap", "pts": pts, "s": p.slot})
	}
}

// damage applies a hit and credits the player with the damage that actually
// landed (capped at remaining HP, so overkill never inflates a loot share).
func (r *Room) damage(f *FishE, p *Player, dmg, critChance float64, wi int) {
	if f.dead || f.gone {
		return
	}
	crit := critChance > 0 && r.rng.Float64() < critChance
	if crit {
		dmg *= 2
	}
	dmg *= 1 - f.armor
	actual := math.Min(dmg, f.hp)
	f.hp -= dmg
	f.dmg[p.slot] += actual
	p.dmg += actual
	p.pendingDmg += actual
	p.combo++
	p.comboT = 2.0
	if p.combo > p.bestCombo {
		p.bestCombo = p.combo
	}
	ev := map[string]any{"k": "h", "f": f.id, "d": math.Round(dmg*10) / 10, "s": p.slot}
	if crit {
		ev["c"] = 1
	}
	r.emit(ev)
	if f.hp <= 1e-9 {
		r.kill(f, p)
	}
}

type lootShare struct {
	slot  int
	share float64
	coins int
	rem   float64
}

func (r *Room) kill(f *FishE, killer *Player) {
	f.dead = true
	d := f.def
	diff := r.zdef().Diff * r.loopMult()

	// --- split loot by credited damage ---
	total := 0.0
	shares := []*lootShare{}
	slots := make([]int, 0, len(f.dmg))
	for s := range f.dmg {
		slots = append(slots, s)
	}
	sort.Ints(slots)
	for _, s := range slots {
		if r.players[s] != nil && f.dmg[s] > 0 {
			total += f.dmg[s]
			shares = append(shares, &lootShare{slot: s})
		}
	}
	baseCoins := int(math.Round(d.Coins * CoinScale * diff * r.pScale() * r.coinMult()))
	baseXP := d.XP * diff * r.pScale()
	loot := [][]float64{}
	if total > 0 {
		// largest-remainder rounding: shares always sum to exactly baseCoins
		assigned := 0
		for _, ls := range shares {
			ls.share = f.dmg[ls.slot] / total
			exact := float64(baseCoins) * ls.share
			ls.coins = int(math.Floor(exact))
			ls.rem = exact - float64(ls.coins)
			assigned += ls.coins
		}
		order := append([]*lootShare{}, shares...)
		sort.SliceStable(order, func(i, j int) bool { return order[i].rem > order[j].rem })
		for i := 0; assigned < baseCoins && i < len(order); i++ {
			order[i].coins++
			assigned++
		}
		for _, ls := range shares {
			p := r.players[ls.slot]
			god := r.godActive(p.prof)
			coins := int(math.Round(float64(ls.coins) * (1 + r.skill(p, "coinBonus"))))
			xp := baseXP * ls.share * (1 + r.skill(p, "xpBonus"))
			comboMult := 1 + math.Min(float64(p.combo), 100)*0.02
			p.score += float64(d.Score) * diff * ls.share * comboMult
			if god {
				coins, xp = 0, 0
			}
			p.coins += coins
			p.xp += xp
			isKiller := p == killer
			r.hub.store.Mutate(func() {
				p.prof.Coins += coins
				p.prof.Lifetime += coins
				if isKiller {
					p.prof.Kills++
				}
				p.prof.XP += xp
				for p.prof.XP >= float64(xpForLevel(p.prof.Level)) {
					p.prof.XP -= float64(xpForLevel(p.prof.Level))
					p.prof.Level++
					p.prof.Picks++
				}
			})
			if p.prof.Picks > 0 && p.offer == nil {
				r.makeOffer(p)
				r.emit(map[string]any{"k": "lvl", "s": p.slot, "l": p.prof.Level})
				r.rosterDirty = true
			}
			p.profDirty = true
			loot = append(loot, []float64{float64(ls.slot), float64(coins), math.Round(ls.share * 100)})
		}
	}
	killer.kills++
	r.emit(map[string]any{"k": "k", "f": f.id, "ty": f.ty, "x": r2(f.x), "z": r2(f.z), "s": killer.slot, "loot": loot})

	if r.phase == "play" && !d.Boss {
		r.progress += float64(d.Score) * r.pScale()
	}
	if d.Boss && f.id == r.bossID {
		r.bossDefeated(f)
		return
	}

	// --- on-death effects ---
	if d.SplitInto != "" {
		for i := 0; i < d.SplitN; i++ {
			c := r.spawnFish(fishIndex[d.SplitInto], f.x+(r.rng.Float64()-0.5)*1.5, f.z+(r.rng.Float64()-0.5)*1.5)
			c.dir = f.dir
		}
	}
	switch d.OnDeath {
	case "revive":
		c := r.spawnFish(fishIndex["bonefish"], f.x, f.z)
		c.dir = f.dir
		r.emit(map[string]any{"k": "fx", "fx": "revive", "x": r2(f.x), "z": r2(f.z)})
	case "chain":
		r.chainFrom(f, killer, 30*diff, 5, 8, 0)
	}
}

// ---------------- skills ----------------

func (r *Room) makeOffer(p *Player) {
	avail := []string{}
	for _, s := range Skills {
		if p.prof.Skills[s.ID] < s.Max-1e-9 {
			avail = append(avail, s.ID)
		}
	}
	r.rng.Shuffle(len(avail), func(i, j int) { avail[i], avail[j] = avail[j], avail[i] })
	if len(avail) > 3 {
		avail = avail[:3]
	}
	if len(avail) == 0 {
		p.offer = nil
		return
	}
	p.offer = avail
	p.client.sendJSON(map[string]any{"t": "offer", "ids": avail, "left": p.prof.Picks})
}

func (r *Room) pickSkill(p *Player, id string) bool {
	ok := false
	for _, o := range p.offer {
		if o == id {
			ok = true
		}
	}
	if !ok || p.prof.Picks <= 0 {
		return false
	}
	if !p.client.applySkill(id) {
		return false
	}
	p.offer = nil
	if p.prof.Picks > 0 {
		r.makeOffer(p)
	} else {
		p.client.sendJSON(map[string]any{"t": "offer", "ids": []string{}, "left": 0})
	}
	return true
}
