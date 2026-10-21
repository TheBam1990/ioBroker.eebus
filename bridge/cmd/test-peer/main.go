// Network test peer, excluded from runtime binaries. It acts as an Energy Guard
// and Monitoring Appliance, using the reference stack's public use-case API.
package main

import (
	"bufio"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/enbility/eebus-go/api"
	"github.com/enbility/eebus-go/service"
	ucapi "github.com/enbility/eebus-go/usecases/api"
	"github.com/enbility/eebus-go/usecases/eg/lpc"
	"github.com/enbility/eebus-go/usecases/eg/lpp"
	"github.com/enbility/eebus-go/usecases/ma/mpc"
	shipapi "github.com/enbility/ship-go/api"
	"github.com/enbility/ship-go/cert"
	"github.com/enbility/ship-go/mdns"
	spineapi "github.com/enbility/spine-go/api"
	"github.com/enbility/spine-go/model"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

var mu sync.Mutex

func emit(k string, v any) {
	mu.Lock()
	defer mu.Unlock()
	json.NewEncoder(os.Stdout).Encode(map[string]any{"event": k, "data": v})
}

type peer struct {
	s   *service.Service
	lpc *lpc.LPC
	lpp *lpp.LPP
	mpc *mpc.MPC
}

func (p *peer) RemoteServiceConnected(_ api.ServiceInterface, id shipapi.ServiceIdentity) {
	emit("connected", id)
}
func (p *peer) RemoteServiceDisconnected(_ api.ServiceInterface, id shipapi.ServiceIdentity) {
	emit("disconnected", id)
}
func (p *peer) VisibleRemoteMdnsServicesUpdated(_ api.ServiceInterface, e []shipapi.RemoteMdnsService) {
	emit("discovery", e)
}
func (p *peer) ServiceUpdated(_ shipapi.ServiceIdentity) {}
func (p *peer) ServicePairingDetailUpdate(id shipapi.ServiceIdentity, d *shipapi.ConnectionStateDetail) {
	emit("pairing", map[string]any{"ski": id.SKI, "state": d.State()})
}
func (p *peer) AllowWaitingForTrust(_ shipapi.ServiceIdentity) bool                  { return true }
func (p *peer) ServiceAutoTrusted(_ api.ServiceInterface, _ shipapi.ServiceIdentity) {}
func (p *peer) ServiceAutoTrustFailed(_ api.ServiceInterface, _ shipapi.ServiceIdentity, e error) {
	emit("error", e.Error())
}
func (p *peer) ServiceAutoTrustRemoved(_ api.ServiceInterface, _ shipapi.ServiceIdentity, _ string) {}
func main() {
	port := flag.Int("port", 54713, "test listener port")
	ski := flag.String("ski", "", "remote SKI")
	flag.Parse()
	c, e := cert.CreateCertificate("test", "ioBroker", "DE", fmt.Sprint("test-peer-", *port))
	if e != nil {
		panic(e)
	}
	x, _ := x509.ParseCertificate(c.Certificate[0])
	localSKI, _ := cert.SkiFromCertificate(x)
	cfg, e := api.NewConfiguration("ioBroker", "ioBroker", "EEBUS Test Peer", fmt.Sprint(*port), []shipapi.DeviceCategoryType{shipapi.DeviceCategoryTypeGridConnectionHub}, model.DeviceTypeTypeElectricitySupplySystem, []model.EntityTypeType{model.EntityTypeTypeGridGuard}, *port, c, time.Second*4, nil, nil)
	if e != nil {
		panic(e)
	}
	cfg.SetMdnsProviderSelection(mdns.MdnsProviderSelectionGoZeroConfOnly)
	p := &peer{}
	p.s = service.NewService(cfg, p)
	if e = p.s.Setup(); e != nil {
		panic(e)
	}
	entity := p.s.LocalDevice().EntityForType(model.EntityTypeTypeGridGuard)
	cb := func(s string, _ spineapi.DeviceRemoteInterface, _ spineapi.EntityRemoteInterface, e api.EventType) {
		emit("useCaseEvent", map[string]any{"ski": s, "event": e})
	}
	p.lpc = lpc.NewLPC(entity, cb)
	p.lpp = lpp.NewLPP(entity, cb)
	p.mpc = mpc.NewMPC(entity, cb)
	for _, uc := range []api.UseCaseInterface{p.lpc, p.lpp, p.mpc} {
		if e = p.s.AddUseCase(uc); e != nil {
			panic(e)
		}
	}
	p.s.RegisterRemoteService(shipapi.NewServiceIdentity(*ski, "", ""))
	p.s.UserIsAbleToApproveOrCancelPairingRequests(true)
	if e = p.s.Start(); e != nil {
		panic(e)
	}
	defer p.s.Shutdown()
	emit("ready", map[string]string{"ski": localSKI})
	commands := make(chan struct {
		Op       string
		Value    float64
		Duration int
	})
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			var c struct {
				Op       string
				Value    float64
				Duration int
			}
			if json.Unmarshal(scanner.Bytes(), &c) == nil {
				commands <- c
			}
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
	for {
		select {
		case c := <-commands:
			cb := func(r model.ResultDataType, _ model.MsgCounterType) { emit("writeResult", r) }
			limit := ucapi.LoadLimit{Value: c.Value, IsActive: true, Duration: time.Duration(c.Duration) * time.Second}
			var err error
			if c.Op == "lpc" {
				for _, r := range p.lpc.RemoteEntitiesScenarios() {
					_, err = p.lpc.WriteConsumptionLimit(r.Entity, limit, cb)
					break
				}
			}
			if c.Op == "lpp" {
				for _, r := range p.lpp.RemoteEntitiesScenarios() {
					_, err = p.lpp.WriteProductionLimit(r.Entity, limit, cb)
					break
				}
			}
			if err != nil {
				emit("error", err.Error())
			}
		case <-ticker.C:
			for _, r := range p.mpc.RemoteEntitiesScenarios() {
				power, e := p.mpc.Power(r.Entity)
				if e == nil {
					emit("power", power)
				}
			}
		case <-sig:
			return
		}
	}
}
