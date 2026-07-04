// Package pluto is a minimal Go client for the Pluto BaaS.
//
//	client := pluto.New("https://api.example.com", pluto.WithAnonKey("pluto_..."))
//	var todos []map[string]any
//	err := client.Rest("todos").Eq("done", false).Limit(10).Do(ctx, &todos)
//
// Not a full port — REST query builder, GraphQL, auth password grant,
// storage upload/download, and edge invoke.
package pluto

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	BaseURL   string
	AnonKey   string
	Workspace string
	Token     string
	HTTP      *http.Client
}

type Option func(*Client)

func WithAnonKey(k string) Option   { return func(c *Client) { c.AnonKey = k } }
func WithWorkspace(w string) Option { return func(c *Client) { c.Workspace = w } }
func WithToken(t string) Option     { return func(c *Client) { c.Token = t } }

func New(baseURL string, opts ...Option) *Client {
	c := &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: &http.Client{Timeout: 30 * time.Second}}
	for _, o := range opts {
		o(c)
	}
	return c
}

type Error struct {
	Status int
	Body   string
}

func (e *Error) Error() string { return fmt.Sprintf("pluto[%d]: %s", e.Status, e.Body) }

func (c *Client) headers(extra map[string]string) http.Header {
	h := http.Header{}
	h.Set("apikey", c.AnonKey)
	h.Set("content-type", "application/json")
	if c.Token != "" {
		h.Set("authorization", "Bearer "+c.Token)
	}
	if c.Workspace != "" {
		h.Set("x-workspace-id", c.Workspace)
	}
	for k, v := range extra {
		h.Set(k, v)
	}
	return h
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return err
	}
	req.Header = c.headers(nil)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	buf, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return &Error{Status: resp.StatusCode, Body: string(buf)}
	}
	if out == nil || len(buf) == 0 {
		return nil
	}
	return json.Unmarshal(buf, out)
}

// ---------- REST ---------------------------------------------------------
type RestBuilder struct {
	c        *Client
	table    string
	sel      string
	filters  url.Values
	order    string
	limit    *int
	offset   *int
	mode     string // select | insert | update | delete
	insert   any
	update   any
}

func (c *Client) Rest(table string) *RestBuilder {
	return &RestBuilder{c: c, table: table, sel: "*", filters: url.Values{}, mode: "select"}
}
func (b *RestBuilder) Select(cols string) *RestBuilder { b.sel = cols; return b }
func (b *RestBuilder) Eq(col string, v any) *RestBuilder {
	b.filters.Set(col, fmt.Sprintf("eq.%v", v)); return b
}
func (b *RestBuilder) Gt(col string, v any) *RestBuilder {
	b.filters.Set(col, fmt.Sprintf("gt.%v", v)); return b
}
func (b *RestBuilder) In(col string, vs []string) *RestBuilder {
	b.filters.Set(col, "in.("+strings.Join(vs, ",")+")"); return b
}
func (b *RestBuilder) Order(s string) *RestBuilder    { b.order = s; return b }
func (b *RestBuilder) Limit(n int) *RestBuilder       { b.limit = &n; return b }
func (b *RestBuilder) Offset(n int) *RestBuilder      { b.offset = &n; return b }
func (b *RestBuilder) Insert(v any) *RestBuilder      { b.mode = "insert"; b.insert = v; return b }
func (b *RestBuilder) Update(v any) *RestBuilder      { b.mode = "update"; b.update = v; return b }
func (b *RestBuilder) Delete() *RestBuilder           { b.mode = "delete"; return b }

func (b *RestBuilder) buildPath() string {
	q := url.Values{}
	q.Set("select", b.sel)
	for k, v := range b.filters {
		q[k] = v
	}
	if b.order != "" { q.Set("order", b.order) }
	if b.limit != nil { q.Set("limit", strconv.Itoa(*b.limit)) }
	if b.offset != nil { q.Set("offset", strconv.Itoa(*b.offset)) }
	return "/rest/v1/" + b.table + "?" + q.Encode()
}

func (b *RestBuilder) Do(ctx context.Context, out any) error {
	switch b.mode {
	case "select": return b.c.do(ctx, "GET", b.buildPath(), nil, out)
	case "insert": return b.c.do(ctx, "POST", "/rest/v1/"+b.table, b.insert, out)
	case "update": return b.c.do(ctx, "PATCH", b.buildPath(), b.update, out)
	case "delete": return b.c.do(ctx, "DELETE", b.buildPath(), nil, out)
	}
	return fmt.Errorf("bad mode %s", b.mode)
}

// ---------- GraphQL, Auth, Invoke ---------------------------------------
func (c *Client) GraphQL(ctx context.Context, query string, vars map[string]any, out any) error {
	return c.do(ctx, "POST", "/graphql/v1", map[string]any{"query": query, "variables": vars}, out)
}
func (c *Client) SignIn(ctx context.Context, email, password string) (map[string]any, error) {
	var r map[string]any
	err := c.do(ctx, "POST", "/auth/v1/token?grant_type=password",
		map[string]any{"email": email, "password": password}, &r)
	if err == nil {
		if tok, ok := r["access_token"].(string); ok {
			c.Token = tok
		}
	}
	return r, err
}
func (c *Client) Invoke(ctx context.Context, slug string, payload any, out any) error {
	return c.do(ctx, "POST", "/fn/v3/invoke/"+slug, payload, out)
}
