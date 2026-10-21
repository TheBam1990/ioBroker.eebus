package main

import (
	ucapi "github.com/enbility/eebus-go/usecases/api"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIdentityPersistence(t *testing.T) {
	c := config{DataDir: t.TempDir(), Brand: "ioBroker", Model: "EEBUS", Serial: "test", Generate: true}
	_, first, err := loadIdentity(c)
	if err != nil {
		t.Fatal(err)
	}
	_, second, err := loadIdentity(c)
	if err != nil || first != second {
		t.Fatalf("SKI changed: %s %s %v", first, second, err)
	}
	fi, _ := os.Stat(filepath.Join(c.DataDir, "identity.json"))
	if fi.Mode().Perm() != 0600 {
		t.Fatal("identity permissions")
	}
	if err = os.WriteFile(filepath.Join(c.DataDir, "identity.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = loadIdentity(c); err == nil {
		t.Fatal("corrupt identity must not be silently regenerated")
	}
}
func TestPowerPolicy(t *testing.T) {
	now := time.Now()
	p := powerPolicy{}
	l := ucapi.LoadLimit{Value: 2500, IsActive: true, Duration: 10 * time.Second}
	if v, fs := p.maximum(l, 11000, 4200, 2*time.Hour, true, now); v != 4200 || !fs {
		t.Fatal("init must restrict")
	}
	p.grant(l, now, true)
	if v, fs := p.maximum(l, 11000, 4200, 2*time.Hour, true, now.Add(time.Second)); v != 2500 || fs {
		t.Fatal("active grant")
	}
	if v, fs := p.maximum(l, 11000, 4200, 2*time.Hour, true, now.Add(11*time.Second)); v != 4200 || !fs {
		t.Fatal("expired grant must restrict")
	}
	l.Value = 5000
	l.Duration = time.Hour
	p.grant(l, now.Add(12*time.Second), true)
	if v, fs := p.maximum(l, 11000, 4200, 2*time.Hour, true, now.Add(13*time.Second)); v != 5000 || fs {
		t.Fatal("fresh grant must recover")
	}
	if v, fs := p.maximum(l, 11000, 4200, 2*time.Hour, false, now.Add(3*time.Minute)); v != 4200 || !fs {
		t.Fatal("heartbeat loss")
	}
	l.Value = -3000
	p.grant(l, now, true)
	if v, _ := p.maximum(l, 10000, 4200, 2*time.Hour, true, now); v != 3000 {
		t.Fatal("signed production must use magnitude")
	}
}
func TestSKIValidation(t *testing.T) {
	for _, bad := range []string{"", "xyz", "AA"} {
		if _, err := validSKI(bad); err == nil {
			t.Fatal(bad)
		}
	}
}
