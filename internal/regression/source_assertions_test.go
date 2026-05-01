package regression

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readRepoFile(t *testing.T, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{"..", ".."}, parts...)...)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return strings.ReplaceAll(string(data), "\r\n", "\n")
}

func requireContains(t *testing.T, source string, want string) {
	t.Helper()
	if !strings.Contains(source, want) {
		t.Fatalf("expected source to contain:\n%s", want)
	}
}
