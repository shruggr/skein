package host

// The `blocks` table of the runtime's SQLite store (src/runtime/sqlite.ts):
// records by binary CID. The shell needs only get/has/put.

import (
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

// NotFound is a record missing from the store. Inside a program it reads as EIO.
type NotFound struct{ CID CID }

func (e NotFound) Error() string { return "not found: " + e.CID.String() }

type Store struct{ db *sql.DB }

// OpenStore opens (or creates) a store file. Only the blocks table is touched.
func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS blocks (cid BLOB PRIMARY KEY, bytes BLOB NOT NULL) WITHOUT ROWID`); err != nil {
		db.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return &Store{db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Get returns a record's bytes (a fresh copy the caller owns).
func (s *Store) Get(c CID) ([]byte, error) {
	var b []byte
	err := s.db.QueryRow(`SELECT bytes FROM blocks WHERE cid = ?`, []byte(c)).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, NotFound{c}
	}
	return b, err
}

func (s *Store) Has(c CID) (bool, error) {
	var x int
	err := s.db.QueryRow(`SELECT 1 FROM blocks WHERE cid = ?`, []byte(c)).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Put stores bytes under a CID the caller minted from them.
func (s *Store) Put(c CID, b []byte) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO blocks (cid, bytes) VALUES (?, ?)`, []byte(c), b)
	return err
}
