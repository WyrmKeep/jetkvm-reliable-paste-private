package native

import (
	"errors"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ErrEDIDReadFailed is the only lower-layer EDID failure qualified across the
// native gRPC boundary. Its exact text is a protocol marker, not a diagnostic.
var ErrEDIDReadFailed = errors.New("EDID_READ_FAILED")

func normalizeEDIDReadError(err error) error {
	if err == nil || errors.Is(err, ErrEDIDReadFailed) {
		return err
	}
	remote, ok := status.FromError(err)
	if ok && remote.Code() == codes.Internal && remote.Message() == ErrEDIDReadFailed.Error() {
		return ErrEDIDReadFailed
	}
	return err
}
