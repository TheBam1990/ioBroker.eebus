// EEBUS SHIP/SPINE subprocess. stdout is an NDJSON event stream, stdin commands.
package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/enbility/eebus-go/api"
	"github.com/enbility/eebus-go/features/server"
	"github.com/enbility/eebus-go/service"
	ucapi "github.com/enbility/eebus-go/usecases/api"
	"github.com/enbility/eebus-go/usecases/cs/lpc"
	"github.com/enbility/eebus-go/usecases/cs/lpp"
	"github.com/enbility/eebus-go/usecases/mu/mpc"
	shipapi "github.com/enbility/ship-go/api"
	"github.com/enbility/ship-go/cert"
	"github.com/enbility/ship-go/mdns"
	spineapi "github.com/enbility/spine-go/api"
	"github.com/enbility/spine-go/model"
	"github.com/enbility/spine-go/util"
)

type config struct {
	Port               int      `json:"port"`
	Brand              string   `json:"brand"`
	Model              string   `json:"model"`
	Serial             string   `json:"serial"`
	DataDir            string   `json:"dataDir"`
	CertPEM            string   `json:"certPem"`
	KeyPEM             string   `json:"keyPem"`
	Generate           bool     `json:"generate"`
	Interfaces         []string `json:"interfaces"`
	NominalConsumption float64  `json:"nominalConsumptionW"`
	NominalProduction  float64  `json:"nominalProductionW"`
	Simulation         bool     `json:"simulation"`
	Power              float64  `json:"powerW"`
}
type command struct {
	ID    string  `json:"id"`
	Op    string  `json:"op"`
	SKI   string  `json:"ski"`
	Value float64 `json:"value"`
}
type ucEvent struct {
	Kind, SKI string
	Event     api.EventType
}
type app struct {
	cfg                  config
	svc                  *service.Service
	lpc                  *lpc.LPC
	lpp                  *lpp.LPP
	mpc                  *mpc.MPC
	events               chan ucEvent
	pairing              atomic.Bool
	trusted              map[string]bool
	lpcPolicy, lppPolicy powerPolicy
}

var outputMu sync.Mutex

func emit(kind string, data any) {
	outputMu.Lock()
	defer outputMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"event": kind, "data": data})
}
func atomicJSON(path string, data any) error {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".eebus-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(b)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}
func loadIdentity(c config) (tls.Certificate, string, error) {
	var pair tls.Certificate
	var err error
	if c.CertPEM != "" || c.KeyPEM != "" {
		pair, err = tls.X509KeyPair([]byte(c.CertPEM), []byte(c.KeyPEM))
	} else {
		path := filepath.Join(c.DataDir, "identity.json")
		b, e := os.ReadFile(path)
		if e == nil {
			var saved struct{ Cert, Key string }
			if err = json.Unmarshal(b, &saved); err == nil {
				pair, err = tls.X509KeyPair([]byte(saved.Cert), []byte(saved.Key))
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			err = e
		} else if !c.Generate {
			err = errors.New("no certificate configured and automatic generation disabled")
		} else {
			pair, err = cert.CreateCertificate("EEBUS", c.Brand, "DE", c.Model+"-"+c.Serial)
			if err == nil {
				var key []byte
				key, err = x509.MarshalPKCS8PrivateKey(pair.PrivateKey)
				if err == nil {
					err = atomicJSON(path, map[string]string{"Cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: pair.Certificate[0]})), "Key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))})
				}
			}
		}
	}
	if err != nil {
		return pair, "", err
	}
	parsed, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return pair, "", err
	}
	ski, err := cert.SkiFromCertificate(parsed)
	return pair, ski, err
}
func validSKI(s string) (string, error) {
	s = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(s), ":", ""))
	b, e := hex.DecodeString(s)
	if e != nil || len(b) != 20 {
		return "", errors.New("SKI must contain exactly 40 hexadecimal characters")
	}
	return s, nil
}
func (a *app) setup() error {
	c := a.cfg
	if c.Port < 1 || c.Port > 65535 || c.NominalConsumption <= 0 || c.NominalProduction <= 0 {
		return errors.New("invalid port or nominal power")
	}
	if err := os.MkdirAll(c.DataDir, 0700); err != nil {
		return err
	}
	pair, ski, err := loadIdentity(c)
	if err != nil {
		return fmt.Errorf("certificate: %w", err)
	}
	a.trusted = map[string]bool{}
	if b, e := os.ReadFile(filepath.Join(c.DataDir, "trusted.json")); e == nil {
		if err = json.Unmarshal(b, &a.trusted); err != nil {
			return err
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	configuration, err := api.NewConfiguration("ioBroker", c.Brand, c.Model, c.Serial, []shipapi.DeviceCategoryType{shipapi.DeviceCategoryTypeEnergyManagementSystem}, model.DeviceTypeTypeEnergyManagementSystem, []model.EntityTypeType{model.EntityTypeTypeCEM, model.EntityTypeTypeSmartEnergyAppliance}, c.Port, pair, 4*time.Second, nil, nil)
	if err != nil {
		return err
	}
	configuration.SetInterfaces(c.Interfaces)
	configuration.SetMdnsProviderSelection(mdns.MdnsProviderSelectionGoZeroConfOnly)
	a.svc = service.NewService(configuration, a)
	a.svc.SetLogging(a)
	if err = a.svc.Setup(); err != nil {
		return err
	}
	entity := a.svc.LocalDevice().EntityForType(model.EntityTypeTypeCEM)
	source := model.MeasurementValueSourceTypeMeasuredValue
	if c.Simulation {
		source = model.MeasurementValueSourceTypeCalculatedValue
	}
	a.mpc, err = mpc.NewMPC(a.svc.LocalDevice().EntityForType(model.EntityTypeTypeSmartEnergyAppliance), nil, &mpc.MonitorPowerConfig{ValueSourceTotal: util.Ptr(source)}, nil, nil, nil, nil)
	if err != nil {
		return err
	}
	if err = a.svc.AddUseCase(a.mpc); err != nil {
		return err
	}
	a.lpc = lpc.NewLPC(entity, a.onLPC)
	if err = a.svc.AddUseCase(a.lpc); err != nil {
		return err
	}
	a.lpp = lpp.NewLPP(entity, a.onLPP)
	if err = a.svc.AddUseCase(a.lpp); err != nil {
		return err
	}
	for index, e := range []error{setNominal(entity, model.ElectricalConnectionCharacteristicTypeTypeContractualConsumptionNominalMax, c.NominalConsumption), setNominal(entity, model.ElectricalConnectionCharacteristicTypeTypeContractualProductionNominalMax, c.NominalProduction), a.lpc.SetConsumptionLimit(ucapi.LoadLimit{Value: c.NominalConsumption, IsChangeable: true}), a.lpp.SetProductionLimit(ucapi.LoadLimit{Value: -c.NominalProduction, IsChangeable: true}), a.lpc.SetFailsafeConsumptionActivePowerLimit(math.Min(4200, c.NominalConsumption), true), a.lpp.SetFailsafeProductionActivePowerLimit(math.Min(4200, c.NominalProduction), true), a.lpc.SetFailsafeDurationMinimum(2*time.Hour, true), a.lpp.SetFailsafeDurationMinimum(2*time.Hour, true)} {
		if e != nil {
			return fmt.Errorf("initialization step %d: %w", index, e)
		}
	}
	a.svc.UserIsAbleToApproveOrCancelPairingRequests(true)
	a.svc.SetAutoAccept(false)
	for s, trust := range a.trusted {
		if trust {
			v, e := validSKI(s)
			if e != nil {
				return e
			}
			a.svc.RegisterRemoteService(shipapi.NewServiceIdentity(v, "", ""))
		}
	}
	if err = a.svc.Start(); err != nil {
		return err
	}
	qr, _ := a.svc.QRCodeText()
	emit("trustedPeers", a.trusted)
	emit("ready", map[string]any{"ski": ski, "qrCode": qr, "port": c.Port, "useCases": []string{"LPC", "LPP", "MPC"}, "simulation": c.Simulation})
	return nil
}

// MPC allocates electricalConnectionId 1. The upstream nominal setters currently
// assume ID 0, so update the actual advertised characteristic by its identifier.
func setNominal(entity spineapi.EntityLocalInterface, kind model.ElectricalConnectionCharacteristicTypeType, value float64) error {
	ec, err := server.NewElectricalConnection(entity)
	if err != nil {
		return err
	}
	chars, err := ec.GetCharacteristicsForFilter(model.ElectricalConnectionCharacteristicDataType{CharacteristicType: util.Ptr(kind), CharacteristicContext: util.Ptr(model.ElectricalConnectionCharacteristicContextTypeEntity)})
	if err != nil {
		return err
	}
	if len(chars) != 1 {
		return fmt.Errorf("expected exactly one nominal characteristic %s, got %d", kind, len(chars))
	}
	data := chars[0]
	data.Value = model.NewScaledNumberType(value)
	return ec.UpdateCharacteristic(data, nil)
}
func (a *app) onLPC(s string, _ spineapi.DeviceRemoteInterface, _ spineapi.EntityRemoteInterface, e api.EventType) {
	a.events <- ucEvent{"lpc", s, e}
}
func (a *app) onLPP(s string, _ spineapi.DeviceRemoteInterface, _ spineapi.EntityRemoteInterface, e api.EventType) {
	a.events <- ucEvent{"lpp", s, e}
}
func (a *app) processUC(e ucEvent) {
	emit("useCaseEvent", map[string]any{"useCase": e.Kind, "ski": e.SKI, "event": e.Event})
	switch e.Event {
	case lpc.LimitWriteApprovalRequired:
		for id, limit := range a.lpc.PendingConsumptionLimits() {
			ok := finite(limit.Value) && limit.Value >= 0 && limit.Value <= a.cfg.NominalConsumption
			a.lpc.ApproveOrDenyConsumptionLimit(id, ok, "outside nominal consumption range")
		}
	case lpp.LimitWriteApprovalRequired:
		for id, limit := range a.lpp.PendingProductionLimits() {
			ok := finite(limit.Value) && limit.Value <= 0 && limit.Value >= -a.cfg.NominalProduction
			a.lpp.ApproveOrDenyProductionLimit(id, ok, "outside nominal production range")
		}
	case lpc.ConfigurationWriteApprovalRequired:
		for id, values := range a.lpc.PendingDeviceConfigurations() {
			a.lpc.ApproveOrDenyDeviceConfiguration(id, validDeviceSettings(values, a.cfg.NominalConsumption, a.cfg.NominalProduction), "invalid failsafe configuration")
		}
	case lpp.ConfigurationWriteApprovalRequired:
		for id, values := range a.lpp.PendingDeviceConfigurations() {
			a.lpp.ApproveOrDenyDeviceConfiguration(id, validDeviceSettings(values, a.cfg.NominalConsumption, a.cfg.NominalProduction), "invalid failsafe configuration")
		}
	case lpc.DataUpdateLimit:
		limit, err := a.lpc.ConsumptionLimit()
		if err == nil {
			a.lpcPolicy.grant(limit, time.Now(), a.lpc.IsHeartbeatWithinDuration())
			emit("limit", map[string]any{"useCase": "lpc", "limit": limit})
		}
	case lpp.DataUpdateLimit:
		limit, err := a.lpp.ProductionLimit()
		if err == nil {
			a.lppPolicy.grant(limit, time.Now(), a.lpp.IsHeartbeatWithinDuration())
			emit("limit", map[string]any{"useCase": "lpp", "limit": limit})
		}
	}
}
func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func validDeviceSettings(values []ucapi.PendingDeviceConfiguration, consumption, production float64) bool {
	for _, v := range values {
		if v.Value == nil {
			return false
		}
		switch v.KeyName {
		case model.DeviceConfigurationKeyNameTypeFailsafeConsumptionActivePowerLimit, model.DeviceConfigurationKeyNameTypeFailsafeProductionActivePowerLimit:
			if v.Value.ScaledNumber == nil {
				return false
			}
			value := v.Value.ScaledNumber.GetValue()
			max := consumption
			if v.KeyName == model.DeviceConfigurationKeyNameTypeFailsafeProductionActivePowerLimit {
				max = production
			}
			if !finite(value) || value < 0 || value > max {
				return false
			}
		case model.DeviceConfigurationKeyNameTypeFailsafeDurationMinimum:
			if v.Value.Duration == nil {
				return false
			}
			duration, err := v.Value.Duration.GetTimeDuration()
			if err != nil || duration < 2*time.Hour || duration > 24*time.Hour {
				return false
			}
		}
	}
	return true
}
func (a *app) tick() {
	now := time.Now()
	lpcLimit, _ := a.lpc.ConsumptionLimit()
	lppLimit, _ := a.lpp.ProductionLimit()
	lpcFailsafe, _, err := a.lpc.FailsafeConsumptionActivePowerLimit()
	if err != nil {
		emit("error", err.Error())
		return
	}
	lppFailsafe, _, err := a.lpp.FailsafeProductionActivePowerLimit()
	if err != nil {
		emit("error", err.Error())
		return
	}
	lpcDuration, _, _ := a.lpc.FailsafeDurationMinimum()
	lppDuration, _, _ := a.lpp.FailsafeDurationMinimum()
	consume, fsC := a.lpcPolicy.maximum(lpcLimit, a.cfg.NominalConsumption, lpcFailsafe, lpcDuration, a.lpc.IsHeartbeatWithinDuration(), now)
	produce, fsP := a.lppPolicy.maximum(lppLimit, a.cfg.NominalProduction, lppFailsafe, lppDuration, a.lpp.IsHeartbeatWithinDuration(), now)
	power := a.cfg.Power
	if a.cfg.Simulation {
		power = math.Max(-produce, math.Min(consume, power))
	}
	if err := a.mpc.Update(a.mpc.UpdateDataPowerTotal(power, &now, nil)); err != nil {
		emit("error", err.Error())
		return
	}
	emit("limitsStatus", map[string]any{"lpcActive": lpcLimit.IsActive && (a.lpcPolicy.Until.IsZero() || now.Before(a.lpcPolicy.Until)), "lppActive": lppLimit.IsActive && (a.lppPolicy.Until.IsZero() || now.Before(a.lppPolicy.Until))})
	emit("measurement", map[string]any{"powerW": power, "consumptionMaxW": consume, "productionMaxW": produce, "lpcFailsafe": fsC, "lppFailsafe": fsP, "simulation": a.cfg.Simulation})
}
func (a *app) handle(c command) error {
	switch c.Op {
	case "pairing":
		a.pairing.Store(c.Value > 0)
		emit("pairingWindow", c.Value > 0)
	case "trust", "untrust":
		ski, err := validSKI(c.SKI)
		if err != nil {
			return err
		}
		if c.Op == "trust" {
			a.trusted[ski] = true
		} else {
			delete(a.trusted, ski)
		}
		if err = atomicJSON(filepath.Join(a.cfg.DataDir, "trusted.json"), a.trusted); err != nil {
			return err
		}
		if c.Op == "trust" {
			a.svc.RegisterRemoteService(shipapi.NewServiceIdentity(ski, "", ""))
		} else {
			a.svc.UnregisterRemoteService(shipapi.NewServiceIdentity(ski, "", ""))
		}
		emit("trustedPeers", a.trusted)
	case "power":
		if !finite(c.Value) || c.Value > a.cfg.NominalConsumption || c.Value < -a.cfg.NominalProduction {
			return errors.New("power outside nominal range")
		}
		a.cfg.Power = c.Value
		a.tick()
	case "status":
		a.tick()
	default:
		return errors.New("unknown command")
	}
	return nil
}
func (a *app) RemoteServiceConnected(_ api.ServiceInterface, id shipapi.ServiceIdentity) {
	emit("connected", map[string]any{"ski": id.SKI, "connected": true})
}
func (a *app) RemoteServiceDisconnected(_ api.ServiceInterface, id shipapi.ServiceIdentity) {
	emit("connected", map[string]any{"ski": id.SKI, "connected": false})
}
func (a *app) VisibleRemoteMdnsServicesUpdated(_ api.ServiceInterface, e []shipapi.RemoteMdnsService) {
	emit("discovery", e)
}
func (a *app) ServiceUpdated(id shipapi.ServiceIdentity) { emit("serviceUpdated", id) }
func (a *app) ServicePairingDetailUpdate(id shipapi.ServiceIdentity, d *shipapi.ConnectionStateDetail) {
	msg := ""
	if d.Error() != nil {
		msg = d.Error().Error()
	}
	emit("pairing", map[string]any{"ski": id.SKI, "state": int(d.State()), "error": msg})
}
func (a *app) AllowWaitingForTrust(_ shipapi.ServiceIdentity) bool { return a.pairing.Load() }
func (a *app) ServiceAutoTrusted(_ api.ServiceInterface, id shipapi.ServiceIdentity) {
	emit("autoTrusted", id)
}
func (a *app) ServiceAutoTrustFailed(_ api.ServiceInterface, id shipapi.ServiceIdentity, e error) {
	emit("error", fmt.Sprintf("pairing %s: %v", id.SKI, e))
}
func (a *app) ServiceAutoTrustRemoved(_ api.ServiceInterface, id shipapi.ServiceIdentity, r string) {
	emit("error", fmt.Sprintf("trust removed %s: %s", id.SKI, r))
}
func (a *app) Trace(v ...interface{}) {
	emit("log", map[string]string{"level": "silly", "message": fmt.Sprint(v...)})
}
func (a *app) Tracef(f string, v ...interface{}) { a.Trace(fmt.Sprintf(f, v...)) }
func (a *app) Debug(v ...interface{}) {
	emit("log", map[string]string{"level": "debug", "message": fmt.Sprint(v...)})
}
func (a *app) Debugf(f string, v ...interface{}) { a.Debug(fmt.Sprintf(f, v...)) }
func (a *app) Info(v ...interface{}) {
	emit("log", map[string]string{"level": "info", "message": fmt.Sprint(v...)})
}
func (a *app) Infof(f string, v ...interface{}) { a.Info(fmt.Sprintf(f, v...)) }
func (a *app) Error(v ...interface{}) {
	emit("log", map[string]string{"level": "warn", "message": fmt.Sprint(v...)})
}
func (a *app) Errorf(f string, v ...interface{}) { a.Error(fmt.Sprintf(f, v...)) }
func run() error {
	path := flag.String("config", "", "configuration JSON path")
	flag.Parse()
	raw, err := os.ReadFile(*path)
	if err != nil {
		return err
	}
	a := &app{events: make(chan ucEvent, 512)}
	if err = json.Unmarshal(raw, &a.cfg); err != nil {
		return err
	}
	if err = a.setup(); err != nil {
		if a.svc != nil {
			a.svc.Shutdown()
		}
		return err
	}
	defer a.svc.Shutdown()
	cmds := make(chan command)
	eof := make(chan struct{})
	go func() {
		defer close(eof)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			var c command
			if e := json.Unmarshal(scanner.Bytes(), &c); e != nil {
				emit("error", "invalid command JSON")
				continue
			}
			cmds <- c
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	a.tick()
	for {
		select {
		case c := <-cmds:
			e := a.handle(c)
			msg := ""
			if e != nil {
				msg = e.Error()
			}
			emit("result", map[string]any{"id": c.ID, "ok": e == nil, "error": msg})
		case e := <-a.events:
			a.processUC(e)
		case <-ticker.C:
			a.tick()
		case <-sig:
			return nil
		case <-eof:
			return nil
		}
	}
}
func main() {
	if err := run(); err != nil {
		emit("fatal", err.Error())
		os.Exit(1)
	}
}
