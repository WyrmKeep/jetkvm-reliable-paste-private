package native

import (
	"errors"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestNormalizeEDIDReadErrorRecognizesOnlyExactInternalMarker(t *testing.T) {
	exact := status.Error(codes.Internal, "EDID_READ_FAILED")
	if got := normalizeEDIDReadError(exact); !errors.Is(got, ErrEDIDReadFailed) {
		t.Fatalf("exact internal marker normalized to %v, want stable sentinel", got)
	}

	for name, remote := range map[string]error{
		"raw suffix": status.Error(codes.Internal, "EDID_READ_FAILED: ioctl failed"),
		"wrong code": status.Error(codes.Unavailable, "EDID_READ_FAILED"),
		"generic":    errors.New("EDID_READ_FAILED"),
	} {
		t.Run(name, func(t *testing.T) {
			got := normalizeEDIDReadError(remote)
			if got != remote {
				t.Fatalf("normalizeEDIDReadError() = %v, want original %v", got, remote)
			}
			if errors.Is(got, ErrEDIDReadFailed) {
				t.Fatalf("non-qualified error matched EDID sentinel: %v", got)
			}
		})
	}
}

func TestNormalizeEDIDReadErrorPreservesLocalSentinel(t *testing.T) {
	if got := normalizeEDIDReadError(ErrEDIDReadFailed); !errors.Is(got, ErrEDIDReadFailed) {
		t.Fatalf("local sentinel normalized to %v", got)
	}
}
