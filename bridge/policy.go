package main

import (
	ucapi "github.com/enbility/eebus-go/usecases/api"
	"math"
	"time"
)

// Each direction starts in init restriction. Valid writes enter normal operation.
// Missing heartbeats or an expired grant enter the configured failsafe period.
type powerPolicy struct {
	Seen          bool
	LastWrite     time.Time
	Until         time.Time
	FailsafeUntil time.Time
}

func (p *powerPolicy) grant(limit ucapi.LoadLimit, now time.Time, heartbeat bool) {
	p.Seen = true
	p.LastWrite = now
	p.Until = time.Time{}
	if limit.Duration > 0 {
		p.Until = now.Add(limit.Duration)
	}
	if heartbeat {
		p.FailsafeUntil = time.Time{}
	}
}
func (p *powerPolicy) maximum(limit ucapi.LoadLimit, nominal, failsafe float64, duration time.Duration, heartbeat bool, now time.Time) (float64, bool) {
	if !p.Seen {
		return math.Min(nominal, math.Abs(failsafe)), true
	}
	expired := !p.Until.IsZero() && !now.Before(p.Until)
	missingHeartbeat := !heartbeat && now.Sub(p.LastWrite) >= 2*time.Minute
	if (expired || missingHeartbeat) && p.FailsafeUntil.IsZero() {
		p.FailsafeUntil = now.Add(duration)
	}
	if !p.FailsafeUntil.IsZero() && now.After(p.FailsafeUntil) && heartbeat && !expired {
		p.FailsafeUntil = time.Time{}
	}
	maximum := nominal
	if limit.IsActive && !expired {
		maximum = math.Min(nominal, math.Abs(limit.Value))
	}
	if !p.FailsafeUntil.IsZero() {
		return math.Min(maximum, math.Abs(failsafe)), true
	}
	return maximum, false
}
