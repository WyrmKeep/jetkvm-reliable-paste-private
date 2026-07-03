// hidtype types text into a Linux HID keyboard gadget at configurable pacing.
//
// It is intentionally small and self-contained because it is deployed directly
// to the JetKVM device as /userdata/hidtype for raw paste-harness validation.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"sync"
	"syscall"
	"time"
)

type hidKey struct {
	code byte
	mod  byte
}

const (
	leftCtrl  byte = 0x01
	leftShift byte = 0x02
	rightAlt  byte = 0x40
)

const (
	layoutUK = "uk"
	layoutUS = "us"
)

var errUnsupportedLayout = errors.New("layout must be uk or us")

func buildKeymap(layout string) (map[rune]hidKey, error) {
	switch layout {
	case layoutUS:
		return buildUSKeymap(), nil
	case layoutUK:
		return buildUKKeymap(), nil
	default:
		return nil, errUnsupportedLayout
	}
}

func buildUSKeymap() map[rune]hidKey {
	m := baseKeymap()
	plain := map[rune]byte{
		'\n': 0x28, '\t': 0x2B, ' ': 0x2C, '-': 0x2D, '=': 0x2E,
		'[': 0x2F, ']': 0x30, '\\': 0x31, ';': 0x33, '\'': 0x34,
		'`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38,
	}
	for r, c := range plain {
		m[r] = hidKey{code: c}
	}
	shifted := map[rune]byte{
		'!': 0x1E, '@': 0x1F, '#': 0x20, '$': 0x21, '%': 0x22, '^': 0x23,
		'&': 0x24, '*': 0x25, '(': 0x26, ')': 0x27, '_': 0x2D, '+': 0x2E,
		'{': 0x2F, '}': 0x30, '|': 0x31, ':': 0x33, '"': 0x34, '~': 0x35,
		'<': 0x36, '>': 0x37, '?': 0x38,
	}
	for r, c := range shifted {
		m[r] = hidKey{code: c, mod: leftShift}
	}
	return m
}

func buildUKKeymap() map[rune]hidKey {
	m := baseKeymap()
	plain := map[rune]byte{
		'\n': 0x28, '\t': 0x2B, ' ': 0x2C, '-': 0x2D, '=': 0x2E,
		'[': 0x2F, ']': 0x30, '#': 0x31, ';': 0x33, '\'': 0x34,
		'`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38, '\\': 0x64,
	}
	for r, c := range plain {
		m[r] = hidKey{code: c}
	}
	shifted := map[rune]byte{
		'!': 0x1E, '"': 0x1F, '£': 0x20, '$': 0x21, '%': 0x22, '^': 0x23,
		'&': 0x24, '*': 0x25, '(': 0x26, ')': 0x27, '_': 0x2D, '+': 0x2E,
		'{': 0x2F, '}': 0x30, '~': 0x31, ':': 0x33, '@': 0x34, '¬': 0x35,
		'<': 0x36, '>': 0x37, '?': 0x38, '|': 0x64,
	}
	for r, c := range shifted {
		m[r] = hidKey{code: c, mod: leftShift}
	}
	m['€'] = hidKey{code: 0x21, mod: rightAlt}
	return m
}

func baseKeymap() map[rune]hidKey {
	m := map[rune]hidKey{}
	for i := 0; i < 26; i++ {
		m[rune('a'+i)] = hidKey{code: byte(0x04 + i)}
		m[rune('A'+i)] = hidKey{code: byte(0x04 + i), mod: leftShift}
	}
	for i := 1; i <= 9; i++ {
		m[rune('0'+i)] = hidKey{code: byte(0x1E + i - 1)}
	}
	m['0'] = hidKey{code: 0x27}
	return m
}

type stats struct {
	CharsTyped   int     `json:"charsTyped"`
	Skipped      int     `json:"skipped"`
	Writes       int     `json:"writes"`
	ElapsedMs    float64 `json:"elapsedMs"`
	CharsPerSec  float64 `json:"charsPerSec"`
	WriteP50Us   int64   `json:"writeP50Us"`
	WriteP90Us   int64   `json:"writeP90Us"`
	WriteP99Us   int64   `json:"writeP99Us"`
	WriteMaxUs   int64   `json:"writeMaxUs"`
	StallsOver2  int     `json:"stallsOver2ms"`
	StallsOver5  int     `json:"stallsOver5ms"`
	StallsOver20 int     `json:"stallsOver20ms"`
	FirstStalls  []int   `json:"firstStallCharIdx,omitempty"`
	WriteErrors  int     `json:"writeErrors"`
	LedPings     int     `json:"ledPings,omitempty"`
	LedEchoes    int     `json:"ledEchoes,omitempty"`
	LedLatMs     []int64 `json:"ledLatMs,omitempty"`
}

type reportWriter interface {
	Write([]byte) (int, error)
}

type hidOutput struct {
	mu     sync.Mutex
	writer reportWriter
	lat    *[]int64
	stats  *stats
}

func (h *hidOutput) write(report [8]byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	t := time.Now()
	n, werr := h.writer.Write(report[:])
	us := time.Since(t).Microseconds()
	if h.lat != nil {
		*h.lat = append(*h.lat, us)
	}
	if h.stats == nil {
		return
	}
	if werr != nil || n != len(report) {
		h.stats.WriteErrors++
	}
	switch {
	case us > 20000:
		h.stats.StallsOver20++
		fallthrough
	case us > 5000:
		h.stats.StallsOver5++
		fallthrough
	case us > 2000:
		h.stats.StallsOver2++
		if len(h.stats.FirstStalls) < 10 {
			h.stats.FirstStalls = append(h.stats.FirstStalls, h.stats.CharsTyped)
		}
	}
}

func clearReport() [8]byte {
	return [8]byte{}
}

func keyReport(mod, code byte) [8]byte {
	return [8]byte{mod, 0, code, 0, 0, 0, 0, 0}
}

func tap(out *hidOutput, mod, code byte, hold, rest time.Duration) {
	out.write(keyReport(mod, code))
	if hold > 0 {
		time.Sleep(hold)
	}
	out.write(clearReport())
	if rest > 0 {
		time.Sleep(rest)
	}
}

type runOptions struct {
	text     []byte
	keymap   map[rune]hidKey
	clearDoc bool
	press    time.Duration
	reset    time.Duration
	rate     float64
	gapEvery int
	gap      time.Duration
	ledPing  int
	ledCh    <-chan ledEvent
}

type ledEvent struct {
	at  time.Time
	val byte
}

func typeInput(out *hidOutput, opts runOptions) time.Duration {
	out.write(clearReport())
	if opts.clearDoc {
		tap(out, leftCtrl, 0x04, 30*time.Millisecond, 50*time.Millisecond) // Ctrl+A
		tap(out, 0, 0x4C, 30*time.Millisecond, 50*time.Millisecond)        // Delete
		time.Sleep(300 * time.Millisecond)
		out.write(clearReport())
	}

	start := time.Now()
	var period, hold time.Duration
	if opts.rate > 0 {
		period = time.Duration(float64(time.Second) / opts.rate)
		hold = period / 3
	}
	deadline := start
	for _, r := range string(opts.text) {
		if r == '\r' {
			continue
		}
		k, ok := opts.keymap[r]
		if !ok {
			if out.stats != nil {
				out.stats.Skipped++
			}
			continue
		}
		if opts.rate > 0 {
			// Deadline pacing is immune to time.Sleep overshoot drift.
			deadline = deadline.Add(period)
			tap(out, k.mod, k.code, hold, 0)
			if d := time.Until(deadline); d > 0 {
				time.Sleep(d)
			}
		} else {
			tap(out, k.mod, k.code, opts.press, opts.reset)
		}
		if out.stats != nil {
			out.stats.CharsTyped++
		}
		if opts.gapEvery > 0 && out.stats != nil && out.stats.CharsTyped%opts.gapEvery == 0 && opts.gap > 0 {
			time.Sleep(opts.gap)
		}
		if opts.ledPing > 0 && out.stats != nil && out.stats.CharsTyped%opts.ledPing == 0 {
			pingLED(out, opts.ledCh, out.stats)
		}
	}
	if opts.ledPing > 0 && out.stats != nil && out.stats.LedPings%2 == 1 {
		pingLED(out, opts.ledCh, out.stats)
	}
	elapsed := time.Since(start)
	out.write(clearReport())
	return elapsed
}

func pingLED(out *hidOutput, ledCh <-chan ledEvent, st *stats) {
	if ledCh == nil {
		return
	}
	for len(ledCh) > 0 {
		<-ledCh
	}
	sent := time.Now()
	tap(out, 0, 0x53, time.Millisecond, 0) // NumLock
	st.LedPings++
	select {
	case ev := <-ledCh:
		st.LedEchoes++
		st.LedLatMs = append(st.LedLatMs, ev.at.Sub(sent).Milliseconds())
	case <-time.After(2 * time.Second):
		st.LedLatMs = append(st.LedLatMs, -1)
	}
}

func installSignalClear(out *hidOutput) {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		out.write(clearReport())
		os.Exit(exitCodeForSignal(sig))
	}()
}

func exitCodeForSignal(sig os.Signal) int {
	if sig == syscall.SIGTERM {
		return 143
	}
	return 130
}

func finalizeStats(st *stats, lat []int64, elapsed time.Duration) {
	st.Writes = len(lat)
	st.ElapsedMs = float64(elapsed.Microseconds()) / 1000
	if elapsed > 0 {
		st.CharsPerSec = float64(st.CharsTyped) / elapsed.Seconds()
	}
	if len(lat) > 0 {
		sorted := append([]int64(nil), lat...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		pct := func(p float64) int64 { return sorted[int(p*float64(len(sorted)-1))] }
		st.WriteP50Us = pct(0.50)
		st.WriteP90Us = pct(0.90)
		st.WriteP99Us = pct(0.99)
		st.WriteMaxUs = sorted[len(sorted)-1]
	}
}

func main() {
	press := flag.Duration("press", 5*time.Millisecond, "sleep after press report")
	reset := flag.Duration("reset", 3*time.Millisecond, "sleep after reset report")
	rate := flag.Float64("rate", 0, "chars/sec with absolute-deadline pacing (overrides press/reset)")
	ledPing := flag.Int("ledping", 0, "every N chars send a NumLock toggle and measure LED echo latency")
	dev := flag.String("dev", "/dev/hidg0", "hid gadget device")
	clear := flag.Bool("clear", false, "send Ctrl+A then Delete before typing")
	layout := flag.String("layout", layoutUK, "keyboard layout to encode: uk or us")
	gapEvery := flag.Int("gap-every", 0, "insert a gap after every N chars (0 = never)")
	gap := flag.Duration("gap", 0, "gap duration")
	flag.Parse()

	keymap, err := buildKeymap(*layout)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	text, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read stdin:", err)
		os.Exit(1)
	}

	mode := os.O_WRONLY
	if *ledPing > 0 {
		mode = os.O_RDWR
	}
	f, err := os.OpenFile(*dev, mode, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open gadget:", err)
		os.Exit(1)
	}
	defer f.Close()

	ledCh := make(chan ledEvent, 64)
	if *ledPing > 0 {
		go func() {
			buf := make([]byte, 8)
			for {
				n, rerr := f.Read(buf)
				if rerr != nil {
					return
				}
				if n > 0 {
					select {
					case ledCh <- ledEvent{at: time.Now(), val: buf[0]}:
					default:
					}
				}
			}
		}()
	}

	var lat []int64
	st := stats{}
	out := &hidOutput{writer: f, lat: &lat, stats: &st}
	installSignalClear(out)

	elapsed := typeInput(out, runOptions{
		text:     text,
		keymap:   keymap,
		clearDoc: *clear,
		press:    *press,
		reset:    *reset,
		rate:     *rate,
		gapEvery: *gapEvery,
		gap:      *gap,
		ledPing:  *ledPing,
		ledCh:    ledCh,
	})
	finalizeStats(&st, lat, elapsed)
	json.NewEncoder(os.Stdout).Encode(st)
}
