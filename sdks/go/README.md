# Pluto Go SDK (skeleton)

```go
package main

import (
    "context"
    "fmt"
    pluto "github.com/pluto-baas/pluto-go/pluto"
)

func main() {
    c := pluto.New("https://api.example.com", pluto.WithAnonKey("pluto_..."))
    var todos []map[string]any
    if err := c.Rest("todos").Eq("done", false).Limit(10).Do(context.Background(), &todos); err != nil {
        panic(err)
    }
    fmt.Println(todos)
}
```
