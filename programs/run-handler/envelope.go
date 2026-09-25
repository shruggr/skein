package main

import "github.com/shruggr/skein/programs/skein"

// envelopeOf reads the envelope's metadata (no decrypt: step 2 only needs the sender).
func envelopeOf(c skein.CID) (*skein.Envelope, error) {
	raw, err := skein.Get(c)
	if err != nil {
		return nil, err
	}
	var env skein.Envelope
	return &env, skein.Decode(raw, &env)
}
