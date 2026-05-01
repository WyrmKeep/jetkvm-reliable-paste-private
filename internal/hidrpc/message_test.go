package hidrpc

import "testing"

func TestKeyboardMacroStateMessageIncludesFailureFlag(t *testing.T) {
	message := NewKeyboardMacroStateMessage(false, true, true)

	data, err := message.Marshal()
	if err != nil {
		t.Fatalf("marshal keyboard macro state: %v", err)
	}

	want := []byte{byte(TypeKeyboardMacroState), 0, 1, 1}
	if string(data) != string(want) {
		t.Fatalf("unexpected keyboard macro state payload: got %v, want %v", data, want)
	}

	var decoded Message
	if err := Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal keyboard macro state: %v", err)
	}
	state, err := decoded.KeyboardMacroState()
	if err != nil {
		t.Fatalf("decode keyboard macro state: %v", err)
	}
	if state.State || !state.IsPaste || !state.Failed {
		t.Fatalf("unexpected keyboard macro state: %+v", state)
	}
}

func TestKeyboardMacroStateMessageReadsLegacyPayloadWithoutFailure(t *testing.T) {
	var decoded Message
	if err := Unmarshal([]byte{byte(TypeKeyboardMacroState), 0, 1}, &decoded); err != nil {
		t.Fatalf("unmarshal legacy keyboard macro state: %v", err)
	}

	state, err := decoded.KeyboardMacroState()
	if err != nil {
		t.Fatalf("decode legacy keyboard macro state: %v", err)
	}
	if state.State || !state.IsPaste || state.Failed {
		t.Fatalf("unexpected legacy keyboard macro state: %+v", state)
	}
}

func TestKeyboardMacroStateMessageRejectsMalformedPayload(t *testing.T) {
	var decoded Message
	if err := Unmarshal([]byte{byte(TypeKeyboardMacroState), 1}, &decoded); err != nil {
		t.Fatalf("unmarshal malformed keyboard macro state: %v", err)
	}

	if _, err := decoded.KeyboardMacroState(); err == nil {
		t.Fatal("expected malformed keyboard macro state to fail")
	}
}
