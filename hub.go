package main

import (
	"encoding/json"
	"log"
	"math"
	"math/rand"
	"strings"
	"sync"
	"time"
)

type Hub struct {
	mu     sync.Mutex
	rooms  map[string]*Room
	online map[string]*Client // lowercase name -> client
	store  *Store
	cfg    Config
}

func NewHub(store *Store, cfg Config) *Hub {
	return &Hub{rooms: map[string]*Room{}, online: map[string]*Client{}, store: store, cfg: cfg}
}

type Client struct {
	hub     *Hub
	ws      *WSConn
	send    chan []byte
	prof    *Profile
	room    *Room
	player  *Player
	closeMu sync.Once
	done    chan struct{}
}

type inMsg struct {
	T    string  `json:"t"`
	Code string  `json:"code"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
	F    bool    `json:"f"`
	ID   string  `json:"id"`
	Kind string  `json:"kind"`
	On   bool    `json:"on"`
	C    float64 `json:"c"`
}

const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func (h *Hub) newCode() string {
	for {
		b := make([]byte, 5)
		for i := range b {
			b[i] = roomAlphabet[rand.Intn(len(roomAlphabet))]
		}
		code := string(b)
		if _, ok := h.rooms[code]; !ok {
			return code
		}
	}
}

func (c *Client) sendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("marshal: %v", err)
		return
	}
	c.sendRaw(b, false)
}

// sendRaw queues a message. Droppable messages (snapshots) are skipped when
// the client is behind; others close a hopelessly stalled connection.
func (c *Client) sendRaw(b []byte, droppable bool) {
	if droppable && len(c.send) > 24 {
		return
	}
	select {
	case c.send <- b:
	case <-c.done:
	default:
		log.Printf("client %s send buffer full, disconnecting", c.prof.Name)
		c.close()
	}
}

func (c *Client) close() {
	c.closeMu.Do(func() {
		close(c.done)
		c.ws.Close()
	})
}

func (c *Client) writer() {
	for {
		select {
		case b := <-c.send:
			if err := c.ws.WriteText(b); err != nil {
				c.close()
				return
			}
		case <-c.done:
			return
		}
	}
}

func (h *Hub) Serve(ws *WSConn, prof *Profile) {
	c := &Client{hub: h, ws: ws, send: make(chan []byte, 256), prof: prof, done: make(chan struct{})}
	key := strings.ToLower(prof.Name)
	h.mu.Lock()
	if old, ok := h.online[key]; ok {
		old.sendJSON(map[string]any{"t": "kicked", "msg": "You signed in somewhere else."})
		time.AfterFunc(200*time.Millisecond, old.close)
	}
	h.online[key] = c
	h.mu.Unlock()

	go c.writer()
	c.sendJSON(map[string]any{"t": "hello", "me": h.store.ViewOf(prof), "defs": defsPayload()})

	defer func() {
		c.leaveRoom()
		h.mu.Lock()
		if h.online[key] == c {
			delete(h.online, key)
		}
		h.mu.Unlock()
		c.close()
	}()

	for {
		ws.SetReadDeadline(time.Now().Add(60 * time.Second))
		b, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var m inMsg
		if err := json.Unmarshal(b, &m); err != nil {
			continue
		}
		c.handle(&m)
	}
}

func defsPayload() map[string]any {
	return map[string]any{
		"weapons": Weapons, "skills": Skills, "fish": Fish, "zones": Zones,
		"events": Events, "boats": Boats, "chars": Characters, "colors": PlayerColors,
		"field": map[string]float64{"minX": FieldMinX, "maxX": FieldMaxX, "minZ": FieldMinZ, "maxZ": FieldMaxZ, "boatZ": BoatZ, "fishY": FishY},
		"slots": SlotX,
	}
}

func (c *Client) toast(msg, kind string) {
	c.sendJSON(map[string]any{"t": "toast", "msg": msg, "kind": kind})
}

func (c *Client) handle(m *inMsg) {
	switch m.T {
	case "ping":
		c.sendJSON(map[string]any{"t": "pong", "c": m.C})
	case "create":
		c.leaveRoom()
		h := c.hub
		h.mu.Lock()
		r := NewRoom(h, h.newCode())
		h.rooms[r.code] = r
		h.mu.Unlock()
		go r.run()
		c.joinRoom(r)
	case "join":
		code := strings.ToUpper(strings.TrimSpace(m.Code))
		c.hub.mu.Lock()
		r := c.hub.rooms[code]
		c.hub.mu.Unlock()
		if r == nil {
			c.sendJSON(map[string]any{"t": "joinError", "msg": "No room with code " + code + ". Check the code with your host."})
			return
		}
		if c.room == r {
			return
		}
		c.leaveRoom()
		c.joinRoom(r)
	case "leave":
		c.leaveRoom()
		c.sendJSON(map[string]any{"t": "left", "me": c.hub.store.ViewOf(c.prof)})
	case "aim":
		if r := c.room; r != nil && c.player != nil {
			if math.IsNaN(m.X) || math.IsNaN(m.Z) || math.IsInf(m.X, 0) || math.IsInf(m.Z, 0) {
				return
			}
			r.mu.Lock()
			c.player.aimX = clamp(m.X, FieldMinX-4, FieldMaxX+4)
			c.player.aimZ = clamp(m.Z, FieldMinZ-4, BoatZ)
			c.player.firing = m.F
			r.mu.Unlock()
		}
	default:
		// Profile-changing actions. Hold the room lock (if any) so the
		// simulation never sees a half-applied change.
		if r := c.room; r != nil {
			r.mu.Lock()
			defer r.mu.Unlock()
		}
		c.profileAction(m)
	}
}

func (c *Client) profileAction(m *inMsg) {
	s := c.hub.store
	p := c.prof
	changed := false
	switch m.T {
	case "buy":
		switch m.Kind {
		case "weapon":
			i, ok := weaponIndex[m.ID]
			if !ok || p.has(p.Weapons, m.ID) {
				return
			}
			cost := Weapons[i].Cost
			if p.Coins < cost {
				c.toast("You need "+itoa(cost-p.Coins)+" more coins.", "bad")
				return
			}
			s.Mutate(func() { p.Coins -= cost; p.Weapons = append(p.Weapons, m.ID); p.Weapon = m.ID })
			c.toast(Weapons[i].Name+" bought and equipped.", "good")
			changed = true
		case "boat":
			cost, ok := boatCost(m.ID)
			if !ok || p.has(p.Boats, m.ID) {
				return
			}
			if p.Coins < cost {
				c.toast("You need "+itoa(cost-p.Coins)+" more coins.", "bad")
				return
			}
			s.Mutate(func() { p.Coins -= cost; p.Boats = append(p.Boats, m.ID); p.Boat = m.ID })
			c.toast("New boat bought and launched.", "good")
			changed = true
		}
	case "equip":
		switch m.Kind {
		case "weapon":
			if _, ok := weaponIndex[m.ID]; !ok {
				return
			}
			god := c.room != nil && c.room.godActive(p)
			if !p.has(p.Weapons, m.ID) && !god {
				return
			}
			s.Mutate(func() { p.Weapon = m.ID })
			changed = true
		case "boat":
			if !p.has(p.Boats, m.ID) {
				return
			}
			s.Mutate(func() { p.Boat = m.ID })
			changed = true
		case "char":
			if !validChar(m.ID) {
				return
			}
			s.Mutate(func() { p.Char = m.ID })
			changed = true
		}
	case "skill":
		if c.player == nil || c.room == nil {
			// allow spending picks from the lobby too
			if p.Picks > 0 && c.applySkill(m.ID) {
				changed = true
			}
		} else if c.room.pickSkill(c.player, m.ID) {
			changed = true
		}
	case "redeem":
		code := strings.ToLower(strings.TrimSpace(m.Code))
		rw, ok := c.hub.cfg.RedeemCodes[code]
		if !ok || code == "" {
			c.sendJSON(map[string]any{"t": "redeem", "ok": false, "msg": "That code isn't valid."})
			return
		}
		if p.has(p.Redeemed, code) {
			c.sendJSON(map[string]any{"t": "redeem", "ok": false, "msg": "You already used this code."})
			return
		}
		s.Mutate(func() {
			p.Redeemed = append(p.Redeemed, code)
			p.Coins += rw.Coins
			if rw.God {
				p.God = true
			}
		})
		msg := ""
		if rw.Coins > 0 {
			msg = "+" + itoa(rw.Coins) + " coins added. "
		}
		if rw.God {
			msg += "God mode unlocked. Turn it on in Settings; it only works when you're alone in a room."
		}
		c.sendJSON(map[string]any{"t": "redeem", "ok": true, "msg": strings.TrimSpace(msg)})
		changed = true
	case "god":
		if !p.God {
			return
		}
		s.Mutate(func() { p.GodOn = m.On })
		changed = true
	}
	if changed {
		if c.player != nil {
			c.player.profDirty = true
			c.room.rosterDirty = true
		} else {
			c.sendJSON(map[string]any{"t": "me", "me": s.ViewOf(p)})
		}
	}
}

func (c *Client) applySkill(id string) bool {
	i, ok := skillIndex[id]
	if !ok {
		return false
	}
	sk := Skills[i]
	p := c.prof
	if p.Skills[id] >= sk.Max-1e-9 {
		return false
	}
	c.hub.store.Mutate(func() {
		p.Skills[id] = math.Min(sk.Max, p.Skills[id]+sk.Inc)
		p.Picks--
	})
	return true
}

func (c *Client) joinRoom(r *Room) {
	r.mu.Lock()
	pl, err := r.addPlayer(c)
	r.mu.Unlock()
	if err != nil {
		c.sendJSON(map[string]any{"t": "joinError", "msg": err.Error()})
		return
	}
	c.room = r
	c.player = pl
}

func (c *Client) leaveRoom() {
	r := c.room
	if r == nil {
		return
	}
	r.mu.Lock()
	summary := r.removePlayer(c.player)
	empty := r.count() == 0
	r.mu.Unlock()
	c.room = nil
	c.player = nil
	if summary != nil {
		c.sendJSON(map[string]any{"t": "summary", "s": summary})
	}
	if empty {
		c.hub.mu.Lock()
		delete(c.hub.rooms, r.code)
		c.hub.mu.Unlock()
		r.stop()
	}
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func itoa(n int) string {
	neg := n < 0
	if neg {
		n = -n
	}
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
