package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- Profile ----------

type Profile struct {
	Name      string             `json:"name"`
	PassHash  string             `json:"passHash"`
	Salt      string             `json:"salt"`
	Created   int64              `json:"created"`
	Level     int                `json:"level"`
	XP        float64            `json:"xp"`
	Coins     int                `json:"coins"`
	Lifetime  int                `json:"lifetimeCoins"`
	Best      int                `json:"bestScore"`
	Kills     int                `json:"kills"`
	Damage    float64            `json:"damage"`
	BestCombo int                `json:"bestCombo"`
	Weapons   []string           `json:"weapons"`
	Weapon    string             `json:"weapon"`
	Boats     []string           `json:"boats"`
	Boat      string             `json:"boat"`
	Char      string             `json:"char"`
	Skills    map[string]float64 `json:"skills"`
	Picks     int                `json:"pendingPicks"`
	Redeemed  []string           `json:"redeemed"`
	God       bool               `json:"godUnlocked"`
	GodOn     bool               `json:"godOn"`
}

// Public view sent to the owning client.
type ProfileView struct {
	Name      string             `json:"name"`
	Level     int                `json:"level"`
	XP        float64            `json:"xp"`
	NextXP    int                `json:"nextXP"`
	Coins     int                `json:"coins"`
	Lifetime  int                `json:"lifetimeCoins"`
	Best      int                `json:"bestScore"`
	Kills     int                `json:"kills"`
	BestCombo int                `json:"bestCombo"`
	Weapons   []string           `json:"weapons"`
	Weapon    string             `json:"weapon"`
	Boats     []string           `json:"boats"`
	Boat      string             `json:"boat"`
	Char      string             `json:"char"`
	Skills    map[string]float64 `json:"skills"`
	Picks     int                `json:"pendingPicks"`
	God       bool               `json:"godUnlocked"`
	GodOn     bool               `json:"godOn"`
}

func (p *Profile) View() ProfileView {
	sk := map[string]float64{}
	for k, v := range p.Skills {
		sk[k] = v
	}
	return ProfileView{
		Name: p.Name, Level: p.Level, XP: p.XP, NextXP: xpForLevel(p.Level), Coins: p.Coins,
		Lifetime: p.Lifetime, Best: p.Best, Kills: p.Kills, BestCombo: p.BestCombo,
		Weapons: append([]string{}, p.Weapons...), Weapon: p.Weapon,
		Boats: append([]string{}, p.Boats...), Boat: p.Boat, Char: p.Char,
		Skills: sk, Picks: p.Picks, God: p.God, GodOn: p.GodOn,
	}
}

func (p *Profile) has(list []string, id string) bool {
	for _, v := range list {
		if v == id {
			return true
		}
	}
	return false
}

func (p *Profile) normalize() {
	if p.Level < 1 {
		p.Level = 1
	}
	if p.Skills == nil {
		p.Skills = map[string]float64{}
	}
	if len(p.Weapons) == 0 || !p.has(p.Weapons, "basic") {
		p.Weapons = append([]string{"basic"}, p.Weapons...)
	}
	if _, ok := weaponIndex[p.Weapon]; !ok || !p.has(p.Weapons, p.Weapon) {
		p.Weapon = "basic"
	}
	for _, b := range Boats {
		if b.Cost == 0 && !p.has(p.Boats, b.ID) {
			p.Boats = append(p.Boats, b.ID)
		}
	}
	if _, ok := boatCost(p.Boat); !ok || !p.has(p.Boats, p.Boat) {
		p.Boat = "boat-row-large"
	}
	if !validChar(p.Char) {
		p.Char = "character-male-a"
	}
}

// ---------- Config ----------

type RedeemReward struct {
	Coins int    `json:"coins,omitempty"`
	God   bool   `json:"god,omitempty"`
	Note  string `json:"note,omitempty"`
}

type Config struct {
	Addr        string                  `json:"addr"`
	RedeemCodes map[string]RedeemReward `json:"redeemCodes"`
}

func loadConfig(path string) Config {
	cfg := Config{
		Addr: ":8080",
		RedeemCodes: map[string]RedeemReward{
			"welcome": {Coins: 500, Note: "Starter coins"},
			"kraken":  {Coins: 2500, Note: "Kraken bounty"},
			"admin":   {God: true, Note: "Unlocks god mode (solo rooms only). Change this code!"},
		},
	}
	b, err := os.ReadFile(path)
	if err != nil {
		out, _ := json.MarshalIndent(cfg, "", "  ")
		if werr := os.WriteFile(path, out, 0o644); werr == nil {
			log.Printf("wrote default config to %s", path)
		}
		return cfg
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		log.Printf("config parse error (%v), using defaults", err)
	}
	// normalise codes to lowercase
	norm := map[string]RedeemReward{}
	for k, v := range cfg.RedeemCodes {
		norm[strings.ToLower(strings.TrimSpace(k))] = v
	}
	cfg.RedeemCodes = norm
	if cfg.Addr == "" {
		cfg.Addr = ":8080"
	}
	return cfg
}

// ---------- Store ----------

type Store struct {
	mu       sync.Mutex
	path     string
	profiles map[string]*Profile // key: lowercase name
	dirty    bool
	secret   []byte
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9_\-]{3,16}$`)

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "profiles.json"), profiles: map[string]*Profile{}}
	if b, err := os.ReadFile(s.path); err == nil {
		if err := json.Unmarshal(b, &s.profiles); err != nil {
			return nil, err
		}
		for _, p := range s.profiles {
			p.normalize()
		}
	}
	secretPath := filepath.Join(dir, "secret.key")
	if b, err := os.ReadFile(secretPath); err == nil && len(b) >= 32 {
		s.secret = b
	} else {
		s.secret = make([]byte, 32)
		rand.Read(s.secret)
		os.WriteFile(secretPath, s.secret, 0o600)
	}
	go s.flushLoop()
	return s, nil
}

func (s *Store) flushLoop() {
	t := time.NewTicker(5 * time.Second)
	for range t.C {
		s.Flush()
	}
}

// Flush writes profiles atomically (tmp file + rename) if anything changed.
func (s *Store) Flush() {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return
	}
	b, err := json.MarshalIndent(s.profiles, "", "  ")
	s.dirty = false
	s.mu.Unlock()
	if err != nil {
		log.Printf("store marshal: %v", err)
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("store write: %v", err)
		return
	}
	if err := os.Rename(tmp, s.path); err != nil {
		log.Printf("store rename: %v", err)
	}
}

// Mutate runs fn with the store locked and marks it dirty.
func (s *Store) Mutate(fn func()) {
	s.mu.Lock()
	fn()
	s.dirty = true
	s.mu.Unlock()
}

func (s *Store) Get(name string) *Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.profiles[strings.ToLower(name)]
}

// ViewOf returns a consistent snapshot of a profile.
func (s *Store) ViewOf(p *Profile) ProfileView {
	s.mu.Lock()
	defer s.mu.Unlock()
	return p.View()
}

func pbkdf2(pass, salt []byte, iter int) []byte {
	// PBKDF2-HMAC-SHA256, single 32-byte block.
	mac := hmac.New(sha256.New, pass)
	mac.Write(salt)
	var blk [4]byte
	binary.BigEndian.PutUint32(blk[:], 1)
	mac.Write(blk[:])
	u := mac.Sum(nil)
	out := append([]byte{}, u...)
	for i := 1; i < iter; i++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(nil)
		for j := range out {
			out[j] ^= u[j]
		}
	}
	return out
}

const pbkdfIter = 60000

var (
	errBadName  = errors.New("Names are 3–16 letters, numbers, - or _.")
	errBadPass  = errors.New("Passwords need at least 6 characters.")
	errTaken    = errors.New("That name is taken. Log in instead, or pick another.")
	errBadLogin = errors.New("Wrong name or password.")
)

func (s *Store) Register(name, pass string) (*Profile, error) {
	name = strings.TrimSpace(name)
	if !nameRe.MatchString(name) {
		return nil, errBadName
	}
	if len(pass) < 6 || len(pass) > 128 {
		return nil, errBadPass
	}
	salt := make([]byte, 16)
	rand.Read(salt)
	hash := pbkdf2([]byte(pass), salt, pbkdfIter)
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.ToLower(name)
	if _, ok := s.profiles[key]; ok {
		return nil, errTaken
	}
	p := &Profile{Name: name, Salt: hex.EncodeToString(salt), PassHash: hex.EncodeToString(hash), Created: time.Now().Unix()}
	p.normalize()
	s.profiles[key] = p
	s.dirty = true
	return p, nil
}

func (s *Store) Login(name, pass string) (*Profile, error) {
	p := s.Get(strings.TrimSpace(name))
	if p == nil {
		pbkdf2([]byte(pass), []byte("timing-pad"), pbkdfIter) // equalise timing
		return nil, errBadLogin
	}
	salt, _ := hex.DecodeString(p.Salt)
	want, _ := hex.DecodeString(p.PassHash)
	got := pbkdf2([]byte(pass), salt, pbkdfIter)
	if subtle.ConstantTimeCompare(want, got) != 1 {
		return nil, errBadLogin
	}
	return p, nil
}

// Tokens: base64(name|expiry|hmac). Stateless, survive restarts.
func (s *Store) MakeToken(name string) string {
	exp := strconv.FormatInt(time.Now().Add(30*24*time.Hour).Unix(), 10)
	payload := strings.ToLower(name) + "|" + exp
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sig
}

func (s *Store) CheckToken(tok string) *Profile {
	parts := strings.Split(tok, ".")
	if len(parts) != 2 {
		return nil
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil
	}
	mac := hmac.New(sha256.New, s.secret)
	mac.Write(pb)
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(want), []byte(parts[1])) != 1 {
		return nil
	}
	f := strings.Split(string(pb), "|")
	if len(f) != 2 {
		return nil
	}
	exp, _ := strconv.ParseInt(f[1], 10, 64)
	if time.Now().Unix() > exp {
		return nil
	}
	return s.Get(f[0])
}
