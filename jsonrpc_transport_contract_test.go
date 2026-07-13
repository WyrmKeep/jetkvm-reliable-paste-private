package kvm

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/jetkvm/kvm/internal/native"
	"github.com/rs/zerolog"
)

func dispatchFixture(t *testing.T, handler RPCHandler, params map[string]any) (any, error) {
	t.Helper()
	return riskyCallRPCHandler(zerolog.Nop(), handler, params, nil)
}

func marshalSuccessEnvelope(t *testing.T, result any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(JSONRPCResponse{JSONRPC: "2.0", Result: result, ID: "contract"})
	if err != nil {
		t.Fatalf("marshal JSON-RPC response: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode JSON-RPC response: %v", err)
	}
	return decoded
}

func TestTransportGetVideoStateResultIsFlatNativeStruct(t *testing.T) {
	registered, ok := rpcHandlers["getVideoState"]
	if !ok {
		t.Fatal("getVideoState handler is not registered")
	}
	if len(registered.Params) != 0 {
		t.Fatalf("getVideoState params = %v, want none", registered.Params)
	}

	result, err := dispatchFixture(t, RPCHandler{Func: func() (native.VideoState, error) {
		return native.VideoState{Ready: true, Streaming: 2, Width: 1920, Height: 1080, FramePerSecond: 59.94}, nil
	}}, nil)
	if err != nil {
		t.Fatalf("dispatch fixture: %v", err)
	}
	envelope := marshalSuccessEnvelope(t, result)
	wire, ok := envelope["result"].(map[string]any)
	if !ok {
		t.Fatalf("result = %#v, want object", envelope["result"])
	}
	want := map[string]any{
		"ready": true, "streaming": float64(2),
		"width": float64(1920), "height": float64(1080), "fps": 59.94,
	}
	for key, expected := range want {
		if actual := wire[key]; actual != expected {
			t.Errorf("result[%q] = %#v, want %#v", key, actual, expected)
		}
	}
	if _, present := wire["error"]; present {
		t.Fatal("empty native VideoState error was not omitted")
	}
	if _, fabricated := wire["signal"]; fabricated {
		t.Fatal("native getVideoState result unexpectedly contains qualified signal metadata")
	}
}

func TestTransportGetEDIDResultIsRawStringOrError(t *testing.T) {
	registered, ok := rpcHandlers["getEDID"]
	if !ok {
		t.Fatal("getEDID handler is not registered")
	}
	if len(registered.Params) != 0 {
		t.Fatalf("getEDID params = %v, want none", registered.Params)
	}

	const raw = "00ffffffffffff00"
	result, err := dispatchFixture(t, RPCHandler{Func: func() (string, error) { return raw, nil }}, nil)
	if err != nil {
		t.Fatalf("dispatch string fixture: %v", err)
	}
	if got := marshalSuccessEnvelope(t, result)["result"]; got != raw {
		t.Fatalf("result = %#v, want raw EDID string", got)
	}

	result, err = dispatchFixture(t, RPCHandler{Func: func() (string, error) {
		return "", errors.New("edid read failed")
	}}, nil)
	if err == nil || result != nil {
		t.Fatalf("error fixture result = %#v, err = %v; want nil result and error", result, err)
	}
}

func TestTransportSetATXPowerActionHasNoStructuredReceipt(t *testing.T) {
	registered, ok := rpcHandlers["setATXPowerAction"]
	if !ok {
		t.Fatal("setATXPowerAction handler is not registered")
	}
	if len(registered.Params) != 1 || registered.Params[0] != "action" {
		t.Fatalf("setATXPowerAction params = %v, want [action]", registered.Params)
	}

	var action string
	result, err := dispatchFixture(t, RPCHandler{
		Func:   func(value string) error { action = value; return nil },
		Params: []string{"action"},
	}, map[string]any{"action": "power-short"})
	if err != nil {
		t.Fatalf("dispatch action fixture: %v", err)
	}
	if action != "power-short" {
		t.Fatalf("action = %q, want power-short", action)
	}
	if result != nil {
		t.Fatalf("result = %#v, want nil for error-only handler", result)
	}
	if _, present := marshalSuccessEnvelope(t, result)["result"]; present {
		t.Fatal("error-only ATX handler unexpectedly emitted a structured result")
	}
}
