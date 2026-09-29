package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

func main() {
	cfgPath := flag.String("config", "server-config.json", "path to server config")
	dataDir := flag.String("data", "data", "directory for profiles.json")
	webDir := flag.String("web", "web", "directory with the frontend")
	dev := flag.Bool("dev", false, "testing aid: bosses surface after a few kills")
	flag.Parse()

	cfg := loadConfig(*cfgPath)
	if *dev {
		devProgressScale = 0.03
		log.Println("dev mode: bosses surface quickly")
	}
	store, err := NewStore(*dataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	hub := NewHub(store, cfg)

	mux := http.NewServeMux()
	limiter := newLimiter()

	mux.HandleFunc("/api/register", func(w http.ResponseWriter, r *http.Request) {
		authHandler(w, r, limiter, func(name, pass string) (*Profile, error) { return store.Register(name, pass) }, store)
	})
	mux.HandleFunc("/api/login", func(w http.ResponseWriter, r *http.Request) {
		authHandler(w, r, limiter, func(name, pass string) (*Profile, error) { return store.Login(name, pass) }, store)
	})
	defsJSON, _ := json.Marshal(defsPayload())
	mux.HandleFunc("/api/defs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(defsJSON)
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		prof := store.CheckToken(r.URL.Query().Get("token"))
		if prof == nil {
			http.Error(w, "session expired", http.StatusUnauthorized)
			return
		}
		ws, err := Upgrade(w, r)
		if err != nil {
			return
		}
		hub.Serve(ws, prof)
	})
	fs := http.FileServer(http.Dir(*webDir))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".js") || strings.HasSuffix(r.URL.Path, ".html") || r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		fs.ServeHTTP(w, r)
	}))

	port := os.Getenv("PORT")
if port == "" {
    port = strings.TrimPrefix(cfg.Addr, ":")
}

if port == "" {
    port = "8080"
}

srv := &http.Server{
    Addr: ":" + port,
    Handler: mux,
    ReadHeaderTimeout: 10 * time.Second,
}
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		log.Println("shutting down, saving profiles…")
		store.Flush()
		os.Exit(0)
	}()
	log.Printf("Deep Sea Salvo listening on http://localhost%s", cfg.Addr)
	if err := srv.ListenAndServe(); err != nil {
		store.Flush()
		log.Fatal(err)
	}
}

func authHandler(w http.ResponseWriter, r *http.Request, lim *limiter, fn func(string, string) (*Profile, error), store *Store) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i > 0 {
		ip = ip[:i]
	}
	if !lim.allow(ip) {
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{"error": "Too many attempts. Wait a minute and try again."})
		return
	}
	var body struct{ Name, Pass string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Bad request."})
		return
	}
	p, err := fn(body.Name, body.Pass)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"token": store.MakeToken(p.Name), "name": p.Name})
}

// Simple per-IP limiter for auth endpoints: 20 attempts per minute.
type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newLimiter() *limiter { return &limiter{hits: map[string][]time.Time{}} }

func (l *limiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	h := l.hits[ip][:0]
	for _, t := range l.hits[ip] {
		if now.Sub(t) < time.Minute {
			h = append(h, t)
		}
	}
	if len(h) >= 20 {
		l.hits[ip] = h
		return false
	}
	l.hits[ip] = append(h, now)
	return true
}
