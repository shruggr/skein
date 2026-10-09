package pool

import (
	"encoding/json"
	"testing"

	"github.com/icellan/runar/compilers/go/compiler"
)

func TestDumpArtifact(t *testing.T) {
	art, err := compiler.CompileFromSource("Pool.runar.go")
	if err != nil {
		t.Fatal(err)
	}
	abi, _ := json.MarshalIndent(art.ABI, "", " ")
	t.Logf("ABI: %s", abi)
	t.Logf("script len=%d codeSepIdx=%v", len(art.Script)/2, *art.CodeSeparatorIndex)
	t.Logf("state fields: %+v", art.StateFields)
}
