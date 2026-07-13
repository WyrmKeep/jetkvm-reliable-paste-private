package controlsession

import (
	"context"
	"sync"
	"sync/atomic"
)

type Generation uint64

type Outcome string

const (
	OutcomeReleased Outcome = "released"
	OutcomeStale    Outcome = "stale"
	OutcomeUnknown  Outcome = "unknown"
)

type ProducerKind string

const (
	ProducerHIDQueue ProducerKind = "hid_queue"
	ProducerRPC      ProducerKind = "rpc"
	ProducerMacro    ProducerKind = "macro"
	ProducerPaste    ProducerKind = "paste"
)

type Snapshot[T comparable] struct {
	Current    T
	Generation Generation
	HasCurrent bool
	Draining   bool
}

type Receipt struct {
	OperationID        string     `json:"operationId"`
	Generation         Generation `json:"generation"`
	Outcome            Outcome    `json:"outcome"`
	Draining           bool       `json:"draining"`
	ProducersJoined    bool       `json:"producersJoined"`
	MacroInactive      bool       `json:"macroInactive"`
	PasteInactive      bool       `json:"pasteInactive"`
	OrdinaryLeasesZero bool       `json:"ordinaryLeasesZero"`
	KeyboardZero       bool       `json:"keyboardZero"`
	PointerZero        bool       `json:"pointerZero"`
}

type Manager[T comparable] struct {
	opMu sync.Mutex
	mu   sync.Mutex

	current    T
	hasCurrent bool
	generation Generation
	draining   bool
	ordinary   int
	workers    map[uint64]*producerState
	nextWorker uint64
	changed    chan struct{}
}

type producerState struct {
	kind   ProducerKind
	cancel context.CancelFunc
}

type Lease struct {
	manager any
	release func()
	once    sync.Once
	valid   atomic.Bool
}

func (l *Lease) Valid() bool {
	return l != nil && l.manager != nil && l.valid.Load()
}

func (l *Lease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		l.valid.Store(false)
		if l.release != nil {
			l.release()
		}
	})
}

type Producer struct {
	ctx  context.Context
	done func()
	once sync.Once
}

func (p *Producer) Context() context.Context {
	if p == nil {
		return context.Background()
	}
	return p.ctx
}

func (p *Producer) Done() {
	if p == nil {
		return
	}
	p.once.Do(p.done)
}

type maintenanceToken struct{ active atomic.Bool }

type MaintenanceLease struct {
	manager any
	token   *maintenanceToken
}

func (l MaintenanceLease) Valid() bool {
	return l.manager != nil && l.token != nil && l.token.active.Load()
}

func New[T comparable]() *Manager[T] {
	return &Manager[T]{
		workers: make(map[uint64]*producerState),
		changed: make(chan struct{}),
	}
}

func (m *Manager[T]) signalLocked() {
	close(m.changed)
	m.changed = make(chan struct{})
}

func (m *Manager[T]) snapshotLocked() Snapshot[T] {
	return Snapshot[T]{
		Current:    m.current,
		Generation: m.generation,
		HasCurrent: m.hasCurrent,
		Draining:   m.draining,
	}
}

func (m *Manager[T]) Snapshot() Snapshot[T] {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *Manager[T]) PublishInitial(current T) Snapshot[T] {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.hasCurrent {
		return m.snapshotLocked()
	}
	m.generation++
	m.current = current
	m.hasCurrent = true
	m.draining = false
	m.signalLocked()
	return m.snapshotLocked()
}

func (m *Manager[T]) Acquire(expected Generation) (*Lease, bool) {
	m.mu.Lock()
	if !m.hasCurrent || m.draining || expected == 0 || expected != m.generation {
		m.mu.Unlock()
		return nil, false
	}
	m.ordinary++
	lease := &Lease{manager: m}
	lease.valid.Store(true)
	lease.release = func() {
		m.mu.Lock()
		m.ordinary--
		m.signalLocked()
		m.mu.Unlock()
	}
	m.mu.Unlock()
	return lease, true
}

func (m *Manager[T]) OrdinaryCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ordinary
}

func (m *Manager[T]) StartProducer(expected Generation, kind ProducerKind) (*Producer, bool) {
	m.mu.Lock()
	if !m.hasCurrent || m.draining || expected == 0 || expected != m.generation {
		m.mu.Unlock()
		return nil, false
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.nextWorker++
	id := m.nextWorker
	m.workers[id] = &producerState{kind: kind, cancel: cancel}
	producer := &Producer{ctx: ctx}
	producer.done = func() {
		cancel()
		m.mu.Lock()
		delete(m.workers, id)
		m.signalLocked()
		m.mu.Unlock()
	}
	m.mu.Unlock()
	return producer, true
}

func (m *Manager[T]) QuiesceAndZero(ctx context.Context, expected Generation, operationID string, zero func(MaintenanceLease) (keyboardErr, pointerErr error)) Receipt {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.quiesceAndZeroLocked(ctx, expected, operationID, zero)
}

func (m *Manager[T]) quiesceAndZeroLocked(ctx context.Context, expected Generation, operationID string, zero func(MaintenanceLease) (keyboardErr, pointerErr error)) Receipt {
	receipt := Receipt{OperationID: operationID, Generation: expected}
	m.mu.Lock()
	if !m.hasCurrent || expected == 0 || expected != m.generation {
		receipt.Outcome = OutcomeStale
		m.mu.Unlock()
		return receipt
	}
	m.draining = true
	receipt.Draining = true
	for _, worker := range m.workers {
		worker.cancel()
	}
	m.signalLocked()
	m.mu.Unlock()

	if !m.waitFor(ctx, func() bool { return len(m.workers) == 0 }) {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}
	receipt.ProducersJoined = true
	receipt.MacroInactive = true
	receipt.PasteInactive = true

	if !m.waitFor(ctx, func() bool { return m.ordinary == 0 }) {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}
	receipt.OrdinaryLeasesZero = true
	if ctx.Err() != nil {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}

	token := &maintenanceToken{}
	token.active.Store(true)
	maintenance := MaintenanceLease{manager: m, token: token}
	keyboardErr, pointerErr := func() (error, error) {
		defer token.active.Store(false)
		return zero(maintenance)
	}()
	receipt.KeyboardZero = keyboardErr == nil
	receipt.PointerZero = pointerErr == nil
	if ctx.Err() != nil {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}
	if receipt.KeyboardZero && receipt.PointerZero {
		receipt.Outcome = OutcomeReleased
	} else {
		receipt.Outcome = OutcomeUnknown
	}
	return receipt
}
func (m *Manager[T]) zeroBeforeInitialPublicationLocked(
	ctx context.Context,
	generation Generation,
	operationID string,
	zero func(MaintenanceLease) (keyboardErr, pointerErr error),
) Receipt {
	receipt := Receipt{OperationID: operationID, Generation: generation}
	if ctx.Err() != nil {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}
	if !m.waitFor(ctx, func() bool { return len(m.workers) == 0 }) {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}
	receipt.ProducersJoined = true
	receipt.MacroInactive = true
	receipt.PasteInactive = true
	if !m.waitFor(ctx, func() bool { return m.ordinary == 0 }) {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}
	receipt.OrdinaryLeasesZero = true
	if ctx.Err() != nil {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}

	token := &maintenanceToken{}
	token.active.Store(true)
	maintenance := MaintenanceLease{manager: m, token: token}
	keyboardErr, pointerErr := func() (error, error) {
		defer token.active.Store(false)
		return zero(maintenance)
	}()
	receipt.KeyboardZero = keyboardErr == nil
	receipt.PointerZero = pointerErr == nil
	if ctx.Err() != nil || !receipt.KeyboardZero || !receipt.PointerZero {
		receipt.Outcome = OutcomeUnknown
		return receipt
	}
	receipt.Outcome = OutcomeReleased
	return receipt
}

func (m *Manager[T]) waitFor(ctx context.Context, predicate func() bool) bool {
	for {
		m.mu.Lock()
		if predicate() {
			m.mu.Unlock()
			return true
		}
		changed := m.changed
		m.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return false
		}
	}
}

func (m *Manager[T]) Takeover(ctx context.Context, next T, operationID string, zero func(MaintenanceLease) (keyboardErr, pointerErr error)) (Snapshot[T], Receipt) {
	return m.TakeoverPrepared(ctx, next, operationID, nil, zero)
}

func (m *Manager[T]) TakeoverPrepared(
	ctx context.Context,
	next T,
	operationID string,
	prepare func(Generation),
	zero func(MaintenanceLease) (keyboardErr, pointerErr error),
) (Snapshot[T], Receipt) {
	m.opMu.Lock()
	defer m.opMu.Unlock()

	m.mu.Lock()
	hasCurrent := m.hasCurrent
	expected := m.generation
	nextGeneration := expected + 1
	m.mu.Unlock()

	var receipt Receipt
	if hasCurrent {
		receipt = m.quiesceAndZeroLocked(ctx, expected, operationID, zero)
	} else {
		receipt = m.zeroBeforeInitialPublicationLocked(ctx, nextGeneration, operationID, zero)
	}
	if receipt.Outcome != OutcomeReleased {
		return m.Snapshot(), receipt
	}

	m.mu.Lock()
	if ctx.Err() != nil {
		m.mu.Unlock()
		receipt.Outcome = OutcomeUnknown
		return m.Snapshot(), receipt
	}
	m.generation = nextGeneration
	if prepare != nil {
		prepare(nextGeneration)
	}
	if ctx.Err() != nil {
		m.mu.Unlock()
		receipt.Outcome = OutcomeUnknown
		return m.Snapshot(), receipt
	}
	m.current = next
	m.hasCurrent = true
	m.draining = false
	m.signalLocked()
	snapshot := m.snapshotLocked()
	m.mu.Unlock()
	return snapshot, receipt
}

func (m *Manager[T]) Close(ctx context.Context, expected Generation, operationID string, zero func(MaintenanceLease) (keyboardErr, pointerErr error)) Receipt {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	receipt := m.quiesceAndZeroLocked(ctx, expected, operationID, zero)
	if receipt.Outcome != OutcomeReleased {
		return receipt
	}
	m.mu.Lock()
	var empty T
	m.current = empty
	m.hasCurrent = false
	m.signalLocked()
	m.mu.Unlock()
	return receipt
}
