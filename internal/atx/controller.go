package atx

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/jetkvm/kvm/internal/controlsession"
)

type Action string

const (
	ActionPressPower Action = "press_power"
	ActionHoldPower  Action = "hold_power"
	ActionPressReset Action = "press_reset"
)

type Outcome string

const (
	OutcomeApplied        Outcome = "applied"
	OutcomeAlreadyApplied Outcome = "already_applied"
	OutcomeNotSent        Outcome = "not_sent"
	OutcomeUnknown        Outcome = "unknown"
)

type Phase string

const (
	PhaseAdmission Phase = "admission"
	PhaseNewline   Phase = "newline"
	PhaseON        Phase = "on"
	PhaseHold      Phase = "hold"
	PhaseOFF       Phase = "off"
	PhaseCleanup   Phase = "cleanup"
	PhaseComplete  Phase = "complete"
)

type ErrorCode string

const (
	ErrorNone              ErrorCode = ""
	ErrorInvalidRequest    ErrorCode = "invalid_request"
	ErrorGenerationStale   ErrorCode = "generation_stale"
	ErrorExtensionInactive ErrorCode = "extension_inactive"
	ErrorSerialUnavailable ErrorCode = "serial_unavailable"
	ErrorRequestConflict   ErrorCode = "request_conflict"
	ErrorCancelled         ErrorCode = "cancelled"
	ErrorWriteRejected     ErrorCode = "write_rejected"
	ErrorGateClosed        ErrorCode = "gate_closed"
)

type WriteReceipt struct {
	Attempted     bool `json:"attempted"`
	Completed     bool `json:"completed"`
	BytesAccepted int  `json:"bytesAccepted"`
}

type Receipt struct {
	RequestID               string       `json:"requestId"`
	Generation              uint64       `json:"generation"`
	Action                  Action       `json:"action"`
	WireAction              string       `json:"wireAction"`
	FixedPressMS            int          `json:"fixedPressMs"`
	Outcome                 Outcome      `json:"outcome"`
	Replayed                bool         `json:"replayed"`
	AcknowledgedAt          time.Time    `json:"acknowledgedAt"`
	Newline                 WriteReceipt `json:"newline"`
	ON                      WriteReceipt `json:"on"`
	HoldCompleted           bool         `json:"holdCompleted"`
	OFF                     WriteReceipt `json:"off"`
	Cleanup                 WriteReceipt `json:"cleanup"`
	SerialSequenceCompleted bool         `json:"serialSequenceCompleted"`
	ErrorCode               ErrorCode    `json:"errorCode"`
	ErrorPhase              Phase        `json:"errorPhase"`
}

type Sleeper interface {
	Sleep(context.Context, time.Duration) error
}

type ProducerRegistrar interface {
	StartProducer(controlsession.Generation, controlsession.ProducerKind) (*controlsession.Producer, bool)
}

type Dependencies struct {
	Writer      io.Writer
	Sleeper     Sleeper
	Producers   ProducerRegistrar
	Extension   func() bool
	SerialReady func() bool
	Now         func() time.Time
}

type terminalKey struct {
	generation controlsession.Generation
	requestID  string
}

type terminal struct {
	action  Action
	receipt Receipt
}

type Controller struct {
	writer      io.Writer
	sleeper     Sleeper
	producers   ProducerRegistrar
	extension   func() bool
	serialReady func() bool
	now         func() time.Time

	mu        sync.Mutex
	terminals map[terminalKey]terminal
	gate      controlsession.Generation
}

type systemSleeper struct{}

func (systemSleeper) Sleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func NewController(dependencies Dependencies) *Controller {
	if dependencies.Writer == nil || dependencies.Producers == nil || dependencies.Extension == nil || dependencies.SerialReady == nil {
		panic("ATX controller dependencies must not be nil")
	}
	if dependencies.Sleeper == nil {
		dependencies.Sleeper = systemSleeper{}
	}
	if dependencies.Now == nil {
		dependencies.Now = time.Now
	}
	return &Controller{
		writer:      dependencies.Writer,
		sleeper:     dependencies.Sleeper,
		producers:   dependencies.Producers,
		extension:   dependencies.Extension,
		serialReady: dependencies.SerialReady,
		now:         dependencies.Now,
		terminals:   make(map[terminalKey]terminal),
	}
}

func (c *Controller) Execute(ctx context.Context, generation controlsession.Generation, requestID string, action Action) Receipt {
	receipt := newReceipt(generation, requestID, action)
	if requestID == "" || receipt.WireAction == "" {
		receipt.Outcome = OutcomeNotSent
		receipt.ErrorCode = ErrorInvalidRequest
		receipt.ErrorPhase = PhaseAdmission
		return receipt
	}

	producer, ok := c.producers.StartProducer(generation, controlsession.ProducerATX)
	if !ok {
		receipt.Outcome = OutcomeNotSent
		receipt.ErrorCode = ErrorGenerationStale
		receipt.ErrorPhase = PhaseAdmission
		return receipt
	}
	defer producer.Done()

	operationCtx, cancel := context.WithCancel(ctx)
	stopProducerCancel := context.AfterFunc(producer.Context(), cancel)
	defer func() {
		stopProducerCancel()
		cancel()
	}()

	c.mu.Lock()
	defer c.mu.Unlock()

	key := terminalKey{generation: generation, requestID: requestID}
	if previous, found := c.terminals[key]; found {
		if previous.action != action {
			receipt.Outcome = OutcomeNotSent
			receipt.ErrorCode = ErrorRequestConflict
			receipt.ErrorPhase = PhaseAdmission
			return receipt
		}
		replayed := previous.receipt
		replayed.Replayed = true
		if replayed.Outcome == OutcomeApplied {
			replayed.Outcome = OutcomeAlreadyApplied
		}
		return replayed
	}
	if operationCtx.Err() != nil {
		receipt.Outcome = OutcomeNotSent
		receipt.ErrorCode = ErrorCancelled
		receipt.ErrorPhase = PhaseAdmission
		return receipt
	}
	if !c.extension() {
		receipt.Outcome = OutcomeNotSent
		receipt.ErrorCode = ErrorExtensionInactive
		receipt.ErrorPhase = PhaseAdmission
		return receipt
	}
	if !c.serialReady() {
		receipt.Outcome = OutcomeNotSent
		receipt.ErrorCode = ErrorSerialUnavailable
		receipt.ErrorPhase = PhaseAdmission
		return receipt
	}
	if c.gate == generation {
		receipt.Outcome = OutcomeNotSent
		receipt.ErrorCode = ErrorGateClosed
		receipt.ErrorPhase = PhaseAdmission
		return receipt
	}

	receipt.Newline = c.write("\n")
	if !receipt.Newline.Completed {
		return c.finishWriteFailure(key, receipt, PhaseNewline, false, "")
	}
	onCommand, offCommand := commands(action)
	receipt.ON = c.write(onCommand)
	if !receipt.ON.Completed {
		return c.finishWriteFailure(key, receipt, PhaseON, receipt.ON.BytesAccepted > 0, offCommand)
	}

	if err := c.sleeper.Sleep(operationCtx, time.Duration(receipt.FixedPressMS)*time.Millisecond); err != nil {
		receipt.ErrorCode = ErrorCancelled
		receipt.ErrorPhase = PhaseHold
		receipt.Outcome = OutcomeUnknown
		receipt.OFF = c.write(offCommand)
		if !receipt.OFF.Completed {
			receipt.Cleanup = c.write(offCommand)
		}
		c.gate = generation
		c.terminals[key] = terminal{action: action, receipt: receipt}
		return receipt
	}
	receipt.HoldCompleted = true
	receipt.OFF = c.write(offCommand)
	if !receipt.OFF.Completed {
		receipt.Outcome = OutcomeUnknown
		receipt.ErrorCode = ErrorWriteRejected
		receipt.ErrorPhase = PhaseOFF
		receipt.Cleanup = c.write(offCommand)
		c.gate = generation
		c.terminals[key] = terminal{action: action, receipt: receipt}
		return receipt
	}

	receipt.Outcome = OutcomeApplied
	receipt.ErrorPhase = PhaseComplete
	receipt.SerialSequenceCompleted = true
	receipt.AcknowledgedAt = c.now().UTC()
	c.terminals[key] = terminal{action: action, receipt: receipt}
	return receipt
}

func (c *Controller) finishWriteFailure(key terminalKey, receipt Receipt, phase Phase, actionMayHaveStarted bool, offCommand string) Receipt {
	receipt.ErrorCode = ErrorWriteRejected
	receipt.ErrorPhase = phase
	if !actionMayHaveStarted {
		receipt.Outcome = OutcomeNotSent
		return receipt
	}
	receipt.Outcome = OutcomeUnknown
	if offCommand != "" {
		receipt.Cleanup = c.write(offCommand)
	}
	c.gate = key.generation
	c.terminals[key] = terminal{action: receipt.Action, receipt: receipt}
	return receipt
}

func (c *Controller) write(command string) WriteReceipt {
	receipt := WriteReceipt{Attempted: true}
	accepted, err := c.writer.Write([]byte(command))
	if accepted > 0 {
		receipt.BytesAccepted = accepted
	}
	receipt.Completed = err == nil && accepted == len(command)
	return receipt
}

func newReceipt(generation controlsession.Generation, requestID string, action Action) Receipt {
	wireAction := ""
	fixedPressMS := 0
	switch action {
	case ActionPressPower:
		wireAction = "power-short"
		fixedPressMS = 200
	case ActionHoldPower:
		wireAction = "power-long"
		fixedPressMS = 5000
	case ActionPressReset:
		wireAction = "reset"
		fixedPressMS = 200
	}
	return Receipt{
		RequestID:    requestID,
		Generation:   uint64(generation),
		Action:       action,
		WireAction:   wireAction,
		FixedPressMS: fixedPressMS,
	}
}

func commands(action Action) (string, string) {
	switch action {
	case ActionPressPower, ActionHoldPower:
		return "BTN_PWR_ON\n", "BTN_PWR_OFF\n"
	case ActionPressReset:
		return "BTN_RST_ON\n", "BTN_RST_OFF\n"
	default:
		return "", ""
	}
}
