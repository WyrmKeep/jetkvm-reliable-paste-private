package kvm

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jetkvm/kvm/internal/controlsession"
)

type pointerWriterCall struct {
	interfaceName string
	x             int
	y             int
	buttons       uint8
}

func installPointerZeroTestSeams(t *testing.T, absErr, relErr error) (*Session, controlsession.Generation, *[]pointerWriterCall) {
	t.Helper()

	oldManager := sessionManager
	oldAbs := absMouseReportWrite
	oldRel := relMouseReportWrite
	lastAbsolutePointerPosition.mu.Lock()
	oldX := lastAbsolutePointerPosition.x
	oldY := lastAbsolutePointerPosition.y
	lastAbsolutePointerPosition.mu.Unlock()
	manager := controlsession.New[*Session]()
	session := &Session{}
	snapshot := manager.PublishInitial(session)
	session.managerGenerationStore(snapshot.Generation)
	sessionManager = manager

	calls := &[]pointerWriterCall{}
	absMouseReportWrite = func(x, y int, buttons uint8) error {
		*calls = append(*calls, pointerWriterCall{interfaceName: "absolute", x: x, y: y, buttons: buttons})
		if buttons == 0 {
			return absErr
		}
		return nil
	}
	relMouseReportWrite = func(dx, dy int8, buttons uint8) error {
		*calls = append(*calls, pointerWriterCall{interfaceName: "relative", x: int(dx), y: int(dy), buttons: buttons})
		return relErr
	}

	t.Cleanup(func() {
		sessionManager = oldManager
		absMouseReportWrite = oldAbs
		relMouseReportWrite = oldRel
		lastAbsolutePointerPosition.mu.Lock()
		lastAbsolutePointerPosition.x = oldX
		lastAbsolutePointerPosition.y = oldY
		lastAbsolutePointerPosition.mu.Unlock()
	})
	return session, snapshot.Generation, calls
}

func TestMaintenancePointerZeroClearsAbsoluteAndRelativeInterfaces(t *testing.T) {
	session, generation, calls := installPointerZeroTestSeams(t, nil, nil)
	if err := rpcAbsMouseReportForSession(session, 1234, 5678, 1); err != nil {
		t.Fatalf("absolute press: %v", err)
	}

	receipt := sessionManager.QuiesceAndZero(context.Background(), generation, "pointer-zero", func(lease controlsession.MaintenanceLease) (error, error) {
		return nil, maintenancePointerZeroWrite(lease)
	})

	if receipt.Outcome != controlsession.OutcomeReleased || !receipt.PointerZero {
		t.Fatalf("receipt=%+v", receipt)
	}
	want := []pointerWriterCall{
		{interfaceName: "absolute", x: 1234, y: 5678, buttons: 1},
		{interfaceName: "absolute", x: 1234, y: 5678, buttons: 0},
		{interfaceName: "relative", x: 0, y: 0, buttons: 0},
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("pointer writes=%+v, want %+v", *calls, want)
	}
}

func TestMaintenancePointerZeroReportsEitherInterfaceFailure(t *testing.T) {
	absFailure := errors.New("absolute zero failed")
	relFailure := errors.New("relative zero failed")
	tests := []struct {
		name    string
		absErr  error
		relErr  error
		wantErr []error
	}{
		{name: "absolute", absErr: absFailure, wantErr: []error{absFailure}},
		{name: "relative", relErr: relFailure, wantErr: []error{relFailure}},
		{name: "both", absErr: absFailure, relErr: relFailure, wantErr: []error{absFailure, relFailure}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			session, generation, calls := installPointerZeroTestSeams(t, tt.absErr, tt.relErr)
			if err := rpcAbsMouseReportForSession(session, 81, 92, 1); err != nil {
				t.Fatalf("absolute press: %v", err)
			}

			var pointerErr error
			receipt := sessionManager.QuiesceAndZero(context.Background(), generation, "pointer-zero-failure", func(lease controlsession.MaintenanceLease) (error, error) {
				pointerErr = maintenancePointerZeroWrite(lease)
				return nil, pointerErr
			})

			if receipt.Outcome != controlsession.OutcomeUnknown || receipt.PointerZero {
				t.Fatalf("receipt=%+v", receipt)
			}
			for _, wantErr := range tt.wantErr {
				if !errors.Is(pointerErr, wantErr) {
					t.Fatalf("pointer error %v does not preserve %v", pointerErr, wantErr)
				}
			}
			want := []pointerWriterCall{
				{interfaceName: "absolute", x: 81, y: 92, buttons: 1},
				{interfaceName: "absolute", x: 81, y: 92, buttons: 0},
				{interfaceName: "relative", x: 0, y: 0, buttons: 0},
			}
			if !reflect.DeepEqual(*calls, want) {
				t.Fatalf("pointer writes=%+v, want %+v", *calls, want)
			}
		})
	}
}

func TestPointerZeroWithoutCurrentMaintenanceLeaseDoesNotWrite(t *testing.T) {
	oldAbs := absMouseReportWrite
	oldRel := relMouseReportWrite
	writes := 0
	absMouseReportWrite = func(int, int, uint8) error { writes++; return nil }
	relMouseReportWrite = func(int8, int8, uint8) error { writes++; return nil }
	t.Cleanup(func() {
		absMouseReportWrite = oldAbs
		relMouseReportWrite = oldRel
	})

	if err := maintenancePointerZeroWrite(controlsession.MaintenanceLease{}); !errors.Is(err, errStaleControlSession) {
		t.Fatalf("invalid maintenance lease error=%v", err)
	}
	if writes != 0 {
		t.Fatalf("invalid maintenance lease wrote %d pointer reports", writes)
	}

	leaseManager := controlsession.New[int]()
	leaseSnapshot := leaseManager.PublishInitial(1)
	var expiredLease controlsession.MaintenanceLease
	leaseReceipt := leaseManager.QuiesceAndZero(context.Background(), leaseSnapshot.Generation, "capture-maintenance", func(lease controlsession.MaintenanceLease) (error, error) {
		expiredLease = lease
		return nil, nil
	})
	if leaseReceipt.Outcome != controlsession.OutcomeReleased {
		t.Fatalf("capture maintenance receipt=%+v", leaseReceipt)
	}
	if err := maintenancePointerZeroWrite(expiredLease); !errors.Is(err, errStaleControlSession) {
		t.Fatalf("expired maintenance lease error=%v", err)
	}
	if writes != 0 {
		t.Fatalf("expired maintenance lease wrote %d pointer reports", writes)
	}

	manager := controlsession.New[int]()
	snapshot := manager.PublishInitial(1)
	receipt := manager.QuiesceAndZero(context.Background(), snapshot.Generation+1, "stale-pointer-zero", func(lease controlsession.MaintenanceLease) (error, error) {
		return nil, maintenancePointerZeroWrite(lease)
	})
	if receipt.Outcome != controlsession.OutcomeStale || receipt.PointerZero {
		t.Fatalf("stale receipt=%+v", receipt)
	}
	if writes != 0 {
		t.Fatalf("stale maintenance request wrote %d pointer reports", writes)
	}
}
