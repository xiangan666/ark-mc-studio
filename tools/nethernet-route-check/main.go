package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/df-mc/go-nethernet"
	"github.com/df-mc/go-nethernet/endpoint"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

// Make an external-path probe unable to succeed by directly using a LAN NIC.
// Only candidate addresses are restricted; identity and DTLS fingerprints remain intact.
func relayTestTransport(ip string, port int) http.RoundTripper {
	base := &http.Transport{}
	return roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method == "POST" && request.Body != nil {
			body, err := io.ReadAll(request.Body)
			if err != nil {
				return nil, err
			}
			_ = request.Body.Close()
			lines, inserted := []string{}, false
			for _, line := range strings.Split(string(body), "\r\n") {
				if strings.HasPrefix(line, "a=candidate:") {
					parts := strings.Fields(line)
					if !inserted && len(parts) >= 8 && strings.EqualFold(parts[2], "udp") {
						parts[4], parts[5] = "192.0.2.1", "9"
						lines = append(lines, strings.Join(parts, " "))
						inserted = true
					}
				} else if strings.HasPrefix(line, "c=") {
					lines = append(lines, "c=IN IP4 192.0.2.1")
				} else {
					lines = append(lines, line)
				}
			}
			body = []byte(strings.Join(lines, "\r\n"))
			request.Body = io.NopCloser(bytes.NewReader(body))
			request.ContentLength = int64(len(body))
		}
		response, err := base.RoundTrip(request)
		if err != nil || ip == "" || request.Method != "POST" {
			return response, err
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			return nil, err
		}
		if bytes.HasPrefix(body, []byte("v=")) {
			lines := []string{}
			for _, line := range strings.Split(string(body), "\r\n") {
				if strings.HasPrefix(line, "a=candidate:") {
					parts := strings.Fields(line)
					if len(parts) < 8 || parts[4] != ip || parts[5] != fmt.Sprint(port) {
						continue
					}
				}
				lines = append(lines, line)
			}
			body = []byte(strings.Join(lines, "\r\n"))
		}
		response.Body = io.NopCloser(bytes.NewReader(body))
		response.ContentLength = int64(len(body))
		return response, nil
	})
}

func main() {
	url := flag.String("url", "", "required HTTPS signaling origin")
	expectIP := flag.String("expect-ip", "", "required selected remote UDP address")
	expectPort := flag.Int("expect-port", 0, "required selected remote UDP port")
	repeat := flag.Int("repeat", 1, "sequential fresh connections")
	hold := flag.Duration("hold", time.Second, "hold each WebRTC connection")
	flag.Parse()
	if *url == "" {
		fmt.Fprintln(os.Stderr, "--url is required")
		flag.Usage()
		os.Exit(2)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	failed := false
	for iteration := 1; iteration <= *repeat; iteration++ {
		result := map[string]any{"url": *url, "iteration": iteration, "full_minecraft_login": false}
		key, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
		if err != nil {
			panic(err)
		}
		identity, err := nethernet.SelfSignedIdentity(key, "https://authorization.franchise.minecraft-services.net/")
		if err != nil {
			panic(err)
		}
		client := endpoint.ClientConfig{HTTPClient: &http.Client{Transport: relayTestTransport(*expectIP, *expectPort), Timeout: 25 * time.Second}, Logger: logger}.New()
		dialer := nethernet.Dialer{Identity: identity, Log: logger, DisableTrickleICE: true}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		started := time.Now()
		conn, err := dialer.DialContext(ctx, *url, client)
		result["elapsed_ms"] = time.Since(started).Milliseconds()
		if err != nil {
			result["ok"] = false
			result["error"] = err.Error()
			failed = true
		} else {
			remote := conn.RemoteAddr().(*nethernet.Addr)
			result["selected_udp_address"] = remote.SelectedCandidate.Address
			result["selected_udp_port"] = remote.SelectedCandidate.Port
			result["server_identity_verified"] = conn.PublicKey() != nil
			result["webrtc_ice_dtls_sctp_established"] = true
			correct := (*expectIP == "" || *expectIP == remote.SelectedCandidate.Address) && (*expectPort == 0 || *expectPort == int(remote.SelectedCandidate.Port))
			result["ok"] = correct
			if !correct {
				failed = true
			}
			time.Sleep(*hold)
			result["connection_still_open"] = conn.Context().Err() == nil
			if conn.Context().Err() != nil {
				failed = true
				result["ok"] = false
			}
			_ = conn.Close()
		}
		cancel()
		_ = json.NewEncoder(os.Stdout).Encode(result)
		if iteration < *repeat {
			time.Sleep(time.Second)
		}
	}
	if failed {
		os.Exit(1)
	}
}
