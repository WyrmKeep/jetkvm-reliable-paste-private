package kvm

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jetkvm/kvm/internal/hidrpc"
	"github.com/jetkvm/kvm/internal/native"
	"github.com/rs/zerolog"
)

func dispatchFixture(t *testing.T, handler RPCHandler, params map[string]any) (any, error) {
	t.Helper()
	return riskyCallRPCHandler(zerolog.Nop(), handler, params, nil)
}
func marshalEnvelope(t *testing.T, response JSONRPCResponse) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal JSON-RPC response: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode JSON-RPC response: %v", err)
	}
	return decoded
}

func marshalSuccessEnvelope(t *testing.T, result any) map[string]any {
	t.Helper()
	return marshalEnvelope(t, JSONRPCResponse{JSONRPC: "2.0", Result: result, ID: "contract"})
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

func TestTransportGetEDIDResultIsRawEmptyOrQualifiedError(t *testing.T) {
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

	result, err = dispatchFixture(t, RPCHandler{Func: func() (string, error) { return "", nil }}, nil)
	if err != nil {
		t.Fatalf("dispatch empty fixture: %v", err)
	}
	emptyEnvelope := marshalSuccessEnvelope(t, result)
	if got, present := emptyEnvelope["result"]; !present || got != "" {
		t.Fatalf("empty result = %#v, present = %t; want explicit empty string", got, present)
	}

	qualified := marshalEnvelope(t, newJSONRPCHandlerErrorResponse("contract", native.ErrEDIDReadFailed))
	qualifiedError, ok := qualified["error"].(map[string]any)
	if !ok {
		t.Fatalf("qualified error = %#v, want object", qualified["error"])
	}
	if _, present := qualified["result"]; present {
		t.Fatalf("qualified error unexpectedly emitted a result member: %#v", qualified)
	}
	if got := qualifiedError["data"]; got != native.ErrEDIDReadFailed.Error() {
		t.Fatalf("qualified error data = %#v, want exact stable marker", got)
	}

	const rawFailure = "open /dev/v4l-subdev2: permission denied"
	generic := marshalEnvelope(t, newJSONRPCHandlerErrorResponse("contract", errors.New(rawFailure)))
	genericError, ok := generic["error"].(map[string]any)
	if !ok {
		t.Fatalf("generic error = %#v, want object", generic["error"])
	}
	if _, present := genericError["data"]; present {
		t.Fatalf("generic error leaked data: %#v", genericError)
	}
	encodedGeneric, err := json.Marshal(generic)
	if err != nil {
		t.Fatalf("marshal decoded generic error: %v", err)
	}
	if bytes.Contains(encodedGeneric, []byte(rawFailure)) {
		t.Fatalf("generic response leaked raw lower-layer error: %s", encodedGeneric)
	}
}
func TestTransportSensitiveLogsDoNotExposeEDIDOrKeyboardMacroPayloads(t *testing.T) {
	const edidSentinel = "EDID-SENTINEL-DO-NOT-LOG"
	var output bytes.Buffer
	testLogger := zerolog.New(&output).Level(zerolog.TraceLevel)

	logRPCHandlerSuccess(testLogger, "getEDID", time.Millisecond, edidSentinel)
	if strings.Contains(output.String(), edidSentinel) {
		t.Fatalf("EDID success log leaked result: %s", output.String())
	}
	if !strings.Contains(output.String(), "RPC handler returned") {
		t.Fatalf("EDID success log lost status metadata: %s", output.String())
	}

	output.Reset()
	macro := []hidrpc.KeyboardMacroStep{{
		Modifier: 0x02,
		Keys:     []byte{4, 5, 6, 7, 8, 9},
		Delay:    10,
	}}
	logKeyboardMacroExecution(&testLogger, macro)
	logged := output.String()
	if strings.Contains(logged, "\"macro\"") ||
		strings.Contains(logged, "\"Modifier\"") ||
		strings.Contains(logged, "\"Keys\"") ||
		strings.Contains(logged, "[4,5,6,7,8,9]") {
		t.Fatalf("keyboard macro log leaked payload: %s", logged)
	}
	if !strings.Contains(logged, "\"step_count\":1") {
		t.Fatalf("keyboard macro log lost safe step count: %s", logged)
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
	if got, present := marshalSuccessEnvelope(t, result)["result"]; !present || got != nil {
		t.Fatalf("error-only ATX handler result = %#v, present = %t; want explicit null", got, present)
	}
}
