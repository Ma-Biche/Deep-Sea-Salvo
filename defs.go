package main

// All balance data lives here. The client receives these definitions in the
// "hello" message, so there is a single source of truth.

type WeaponDef struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Desc     string  `json:"desc"`
	Cost     int     `json:"cost"`
	Damage   float64 `json:"damage"`
	FireRate float64 `json:"fireRate"` // ms between shots
	Speed    float64 `json:"speed"`    // world units / second
	Kind     string  `json:"kind"`     // normal spread homing explosive pierce chain
	Radius   float64 `json:"radius,omitempty"`
	Pierce   int     `json:"pierce,omitempty"`
	Chain    int     `json:"chain,omitempty"`
	Model    string  `json:"model"`
	Color    string  `json:"color"`
}

var Weapons = []WeaponDef{
	// Single-target DPS rises with price (basic 56 -> Storm Coil 110), and each
	// weapon's specialty (spread, homing, splash, pierce, chain) comes on top.
	{ID: "basic", Name: "Deck Popper", Desc: "Reliable single shot.", Cost: 0, Damage: 10, FireRate: 180, Speed: 26, Kind: "normal", Model: "blaster-a", Color: "#ffd166"},
	{ID: "triple", Name: "Tri-Spreader", Desc: "Three shots in a fan. Best up close.", Cost: 600, Damage: 8, FireRate: 260, Speed: 24, Kind: "spread", Model: "blaster-o", Color: "#7ee081"},
	{ID: "rapid", Name: "Riptide SMG", Desc: "Very fast, steady damage.", Cost: 1500, Damage: 6, FireRate: 70, Speed: 30, Kind: "normal", Model: "blaster-d", Color: "#c39bff"},
	{ID: "homing", Name: "Seeker", Desc: "Shots curve into fish. Rarely misses.", Cost: 3000, Damage: 17, FireRate: 190, Speed: 20, Kind: "homing", Model: "blaster-l", Color: "#8be9fd"},
	{ID: "explosive", Name: "Depth Charger", Desc: "Explodes and hits everything nearby.", Cost: 5000, Damage: 36, FireRate: 380, Speed: 22, Kind: "explosive", Radius: 3.2, Model: "blaster-h", Color: "#ff7b54"},
	{ID: "piercing", Name: "Harpoon Rifle", Desc: "Punches through 3 fish.", Cost: 8000, Damage: 34, FireRate: 300, Speed: 36, Kind: "pierce", Pierce: 3, Model: "blaster-e", Color: "#ffe45e"},
	{ID: "tesla", Name: "Storm Coil", Desc: "Arcs to 3 more fish at 70% damage.", Cost: 12000, Damage: 22, FireRate: 200, Speed: 30, Kind: "chain", Chain: 3, Model: "blaster-q", Color: "#5ce1ff"},
}

type SkillDef struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Desc string  `json:"desc"`
	Inc  float64 `json:"inc"`
	Max  float64 `json:"max"`
	Icon string  `json:"icon"`
}

var Skills = []SkillDef{
	{ID: "attackSpeed", Name: "Quick Trigger", Desc: "+10% fire rate", Inc: 0.1, Max: 2.0, Icon: "hourglass"},
	{ID: "damage", Name: "Heavy Rounds", Desc: "+10% damage", Inc: 0.1, Max: 3.0, Icon: "sword"},
	{ID: "range", Name: "Long Barrel", Desc: "+20% range", Inc: 0.2, Max: 2.0, Icon: "arrow_right"},
	{ID: "critChance", Name: "Weak Spots", Desc: "+5% critical hits (x2)", Inc: 0.05, Max: 1.0, Icon: "fire"},
	{ID: "projectileSpeed", Name: "Hot Powder", Desc: "+15% shot speed", Inc: 0.15, Max: 2.0, Icon: "arrow_right_curve"},
	{ID: "coinBonus", Name: "Deep Pockets", Desc: "+10% coins from your share", Inc: 0.1, Max: 2.0, Icon: "pouch_add"},
	{ID: "xpBonus", Name: "Sea Legs", Desc: "+10% XP from your share", Inc: 0.1, Max: 2.0, Icon: "flask_full"},
}

type FishDef struct {
	ID        string  `json:"id"`
	Sprite    string  `json:"sprite"`
	Tint      string  `json:"tint,omitempty"`
	Glow      float64 `json:"glow,omitempty"`
	HP        float64 `json:"hp"`
	Speed     float64 `json:"speed"`
	Score     int     `json:"score"`
	Radius    float64 `json:"radius"`
	HalfLen   float64 `json:"halfLen"` // capsule half length along x (long fish)
	Size      float64 `json:"size"`    // sprite width in world units
	Move      string  `json:"move"`
	XP        float64 `json:"xp"`
	Coins     float64 `json:"coins"`
	Armor     float64 `json:"armor,omitempty"`
	SplitInto string  `json:"-"`
	SplitN    int     `json:"-"`
	OnDeath   string  `json:"onDeath,omitempty"` // chain | revive
	Boss      bool    `json:"boss,omitempty"`
	Special   string  `json:"special,omitempty"`
	Title     string  `json:"title,omitempty"`
}

var Fish = []FishDef{
	{ID: "small", Sprite: "fish_blue", HP: 5, Speed: 4.8, Score: 5, Radius: 0.5, Size: 1.3, Move: "burst", XP: 5, Coins: 1},
	{ID: "fast", Sprite: "fish_orange", HP: 10, Speed: 7.0, Score: 15, Radius: 0.55, Size: 1.4, Move: "sine", XP: 15, Coins: 4},
	{ID: "tank", Sprite: "fish_brown", HP: 50, Speed: 1.4, Score: 25, Radius: 1.15, Size: 2.8, Move: "straight", XP: 30, Coins: 8},
	{ID: "armored", Sprite: "fish_grey", Tint: "#b8c7d6", HP: 40, Speed: 1.7, Score: 30, Radius: 0.9, Size: 2.2, Move: "straight", XP: 35, Coins: 10, Armor: 0.5},
	{ID: "evasive", Sprite: "fish_pink", HP: 20, Speed: 4.0, Score: 20, Radius: 0.7, Size: 1.7, Move: "zigzag", XP: 20, Coins: 6},
	{ID: "split", Sprite: "fish_green", HP: 30, Speed: 2.4, Score: 30, Radius: 0.95, Size: 2.2, Move: "sine", XP: 25, Coins: 8, SplitInto: "small", SplitN: 3},
	{ID: "golden", Sprite: "fish_orange", Tint: "#ffd84a", Glow: 0.9, HP: 20, Speed: 5.6, Score: 100, Radius: 0.6, Size: 1.5, Move: "burst", XP: 100, Coins: 50},
	{ID: "critical", Sprite: "fish_blue", Tint: "#7df9ff", Glow: 1.2, HP: 30, Speed: 7.5, Score: 150, Radius: 0.6, Size: 1.5, Move: "zigzag", XP: 150, Coins: 75, OnDeath: "chain"},
	{ID: "eel", Sprite: "fish_grey_long_a", Tint: "#9fe0c8", HP: 25, Speed: 3.2, Score: 35, Radius: 0.45, HalfLen: 1.0, Size: 3.2, Move: "sine", XP: 30, Coins: 9},
	{ID: "revenant", Sprite: "fish_red", HP: 25, Speed: 2.8, Score: 30, Radius: 0.8, Size: 2.0, Move: "slow_curve", XP: 25, Coins: 7, OnDeath: "revive"},
	{ID: "bonefish", Sprite: "fish_red_skeleton", HP: 12, Speed: 3.6, Score: 20, Radius: 0.75, Size: 2.0, Move: "zigzag", XP: 15, Coins: 6},
	{ID: "giant", Sprite: "fish_brown", Tint: "#e7a86b", HP: 400, Speed: 1.1, Score: 400, Radius: 2.3, Size: 5.6, Move: "slow_curve", XP: 350, Coins: 180, Boss: true, Title: "Giant Puffer"},
	// Zone bosses (index offset used by zones below)
	{ID: "boss0", Sprite: "fish_grey_long_b", Tint: "#4f7fa6", HP: 1200, Speed: 1.8, Score: 1000, Radius: 1.4, HalfLen: 3.0, Size: 10, Move: "boss", XP: 700, Coins: 400, Boss: true, Title: "Grumblejaw"},
	{ID: "boss1", Sprite: "fish_brown", Tint: "#e0785f", HP: 1500, Speed: 1.4, Score: 1200, Radius: 2.8, Size: 6.8, Move: "boss", XP: 850, Coins: 480, Boss: true, Special: "summon", Title: "Queen Puff"},
	{ID: "boss2", Sprite: "fish_blue_skeleton", Tint: "#b9c6ff", HP: 1700, Speed: 1.6, Score: 1400, Radius: 2.4, Size: 6.4, Move: "boss", XP: 1000, Coins: 560, Boss: true, Armor: 0.3, Special: "armor", Title: "The Ossified"},
	{ID: "boss3", Sprite: "fish_grey_long_a", Tint: "#9a5cf0", Glow: 0.5, HP: 2000, Speed: 2.2, Score: 1600, Radius: 1.2, HalfLen: 3.4, Size: 10.5, Move: "boss", XP: 1200, Coins: 650, Boss: true, Special: "blink", Title: "Rift Eel"},
	{ID: "boss4", Sprite: "fish_grey_long_b", Tint: "#e8603f", Glow: 0.4, HP: 2600, Speed: 1.7, Score: 2000, Radius: 1.8, HalfLen: 3.8, Size: 12.5, Move: "boss", XP: 1500, Coins: 800, Boss: true, Special: "enrage", Title: "Starfall Leviathan"},
}

type ZoneDef struct {
	Name    string         `json:"name"`
	Sky     string         `json:"sky"`
	Diff    float64        `json:"diff"`
	Water   string         `json:"water"`
	Deep    string         `json:"deep"`
	Fog     string         `json:"fog"`
	Floor   string         `json:"floor"`
	Weeds   []string       `json:"weeds"`
	Light   float64        `json:"light"`
	Boss    string         `json:"boss"`
	Weights map[string]int `json:"-"`
}

var Zones = []ZoneDef{
	{Name: "Coral Reef", Sky: "day", Diff: 1.0, Water: "#2fc3d6", Deep: "#0a5f86", Fog: "#9ad9ea", Floor: "terrain_sand_a", Light: 1.0, Boss: "boss0",
		Weeds:   []string{"seaweed_pink_a", "seaweed_pink_b", "seaweed_orange_a", "seaweed_green_a", "seaweed_green_c"},
		Weights: map[string]int{"small": 45, "fast": 25, "tank": 10, "armored": 5, "golden": 4, "eel": 6}},
	{Name: "Sunrise Kelp", Sky: "morning", Diff: 1.25, Water: "#48b8b0", Deep: "#15545e", Fog: "#f5c9a0", Floor: "terrain_sand_a", Light: 0.95, Boss: "boss1",
		Weeds:   []string{"seaweed_green_a", "seaweed_green_b", "seaweed_green_d", "seaweed_grass_a", "seaweed_grass_b"},
		Weights: map[string]int{"small": 30, "tank": 20, "evasive": 20, "split": 15, "eel": 10, "golden": 4, "critical": 2}},
	{Name: "Midnight Trench", Sky: "night", Diff: 1.5, Water: "#2a5c9a", Deep: "#07163a", Fog: "#1c2f55", Floor: "terrain_dirt_a", Light: 0.55, Boss: "boss2",
		Weights: map[string]int{"revenant": 30, "bonefish": 15, "armored": 20, "evasive": 15, "tank": 10, "golden": 4, "critical": 4},
		Weeds:   []string{"seaweed_grass_a", "background_seaweed_a", "seaweed_green_d"}},
	{Name: "Alien Rift", Sky: "alien", Diff: 1.8, Water: "#6ad19a", Deep: "#1d3b3a", Fog: "#8fcf9a", Floor: "terrain_dirt_a", Light: 0.8, Boss: "boss3",
		Weights: map[string]int{"fast": 25, "evasive": 25, "split": 20, "critical": 8, "eel": 15, "golden": 5},
		Weeds:   []string{"seaweed_pink_c", "seaweed_orange_b", "seaweed_pink_a", "background_seaweed_c"}},
	{Name: "Starfall Abyss", Sky: "space", Diff: 2.2, Water: "#4d5fd6", Deep: "#0b0b2e", Fog: "#1b1f4a", Floor: "terrain_dirt_a", Light: 0.6, Boss: "boss4",
		Weights: map[string]int{"revenant": 20, "armored": 20, "split": 20, "critical": 10, "golden": 10, "fast": 15, "eel": 10},
		Weeds:   []string{"background_seaweed_a", "seaweed_grass_b", "seaweed_pink_b"}},
}

type EventDef struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Desc     string  `json:"desc"`
	Duration float64 `json:"duration"`
}

var Events = []EventDef{
	{ID: "frenzy", Name: "Fish Frenzy", Desc: "The water is packed.", Duration: 20},
	{ID: "golden", Name: "Golden Rush", Desc: "Golden fish everywhere.", Duration: 15},
	{ID: "giant", Name: "Giant Hunt", Desc: "A giant puffer surfaced.", Duration: 30},
	{ID: "speed", Name: "Speed Tide", Desc: "Fish move fast. Coins x1.3.", Duration: 20},
	{ID: "swarm", Name: "Swarm", Desc: "Schools of small fish.", Duration: 15},
	{ID: "bounty", Name: "Bounty Wave", Desc: "Heavy fish. Coins x2.", Duration: 25},
}

// Boats give passive buffs that stack on top of upgrade picks (same stat
// keys as Skills). Coin/XP buffs apply to your own share after the split, so
// they never take loot from teammates.
type BoatDef struct {
	ID    string             `json:"id"`
	Name  string             `json:"name"`
	Cost  int                `json:"cost"`
	Buffs map[string]float64 `json:"buffs"`
}

var Boats = []BoatDef{
	{ID: "boat-row-large", Name: "Rowboat", Cost: 0, Buffs: map[string]float64{"range": 0.15}},
	{ID: "boat-fishing-small", Name: "Trawler", Cost: 0, Buffs: map[string]float64{"coinBonus": 0.1}},
	{ID: "boat-speed-a", Name: "Blue Streak", Cost: 400, Buffs: map[string]float64{"attackSpeed": 0.12}},
	{ID: "boat-tug-a", Name: "Tugger", Cost: 900, Buffs: map[string]float64{"damage": 0.15}},
	{ID: "boat-fan", Name: "Fanboat", Cost: 1500, Buffs: map[string]float64{"projectileSpeed": 0.25, "attackSpeed": 0.1}},
	{ID: "boat-speed-e", Name: "Red Dart", Cost: 2500, Buffs: map[string]float64{"critChance": 0.1, "damage": 0.1}},
	{ID: "boat-house-a", Name: "Houseboat", Cost: 4000, Buffs: map[string]float64{"coinBonus": 0.25, "xpBonus": 0.25}},
	{ID: "ship-small-ghost", Name: "Ghost Ship", Cost: 10000, Buffs: map[string]float64{"damage": 0.3, "attackSpeed": 0.2, "critChance": 0.1}},
}

func boatBuff(id, stat string) float64 {
	for _, b := range Boats {
		if b.ID == id {
			return b.Buffs[stat]
		}
	}
	return 0
}

var Characters = []string{
	"character-male-a", "character-male-b", "character-male-c", "character-male-d", "character-male-e", "character-male-f",
	"character-female-a", "character-female-b", "character-female-c", "character-female-d", "character-female-e", "character-female-f",
}

var PlayerColors = []string{"#ffbf3f", "#ff6b4a", "#4fd1ff", "#c08bff"}

// Lookup helpers
var weaponIndex = map[string]int{}
var fishIndex = map[string]int{}
var skillIndex = map[string]int{}

func init() {
	for i, w := range Weapons {
		weaponIndex[w.ID] = i
	}
	for i, f := range Fish {
		fishIndex[f.ID] = i
	}
	for i, s := range Skills {
		skillIndex[s.ID] = i
	}
}

func boatCost(id string) (int, bool) {
	for _, b := range Boats {
		if b.ID == id {
			return b.Cost, true
		}
	}
	return 0, false
}

func validChar(id string) bool {
	for _, c := range Characters {
		if c == id {
			return true
		}
	}
	return false
}

func xpForLevel(level int) int {
	l := float64(level - 1)
	return int(120 + 70*l + 9*l*l)
}

// Coin values in FishDef are multiplied by this before splitting.
const CoinScale = 0.4
