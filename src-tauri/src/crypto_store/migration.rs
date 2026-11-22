use std::path::Path;

use matrix_sdk_store_encryption::StoreCipher;
use rusqlite::{params_from_iter, types::Value, Connection, OpenFlags, TransactionBehavior};
use zeroize::Zeroizing;

// These are the encodings used by matrix-sdk-sqlite 0.16.1's crypto store.
// The SDK hashes lookup columns in a table-specific domain and encrypts values
// after serialization. Public database metadata and replay hashes use SQLite
// directly. A schema change needs an explicit review before migrating it.
const VERSION: &[u8] = &[13];

#[derive(Clone, Copy)]
enum Encoding {
    Plain,
    Hash,
    Encrypted,
}

use Encoding::{Encrypted as Secret, Hash, Plain};

struct Table {
    name: &'static str,
    hash_domain: &'static str,
    columns: &'static [(&'static str, Encoding)],
}

const TABLES: &[Table] = &[
    Table {
        name: "kv",
        hash_domain: "",
        columns: &[("key", Plain), ("value", Secret)],
    },
    Table {
        name: "session",
        hash_domain: "session",
        columns: &[("session_id", Hash), ("sender_key", Hash), ("data", Secret)],
    },
    Table {
        name: "inbound_group_session",
        hash_domain: "inbound_group_session",
        columns: &[
            ("session_id", Hash),
            ("room_id", Hash),
            ("backed_up", Plain),
            ("data", Secret),
            ("sender_key", Hash),
            ("sender_data_type", Plain),
        ],
    },
    Table {
        name: "outbound_group_session",
        hash_domain: "outbound_group_session",
        columns: &[("room_id", Hash), ("data", Secret)],
    },
    Table {
        name: "device",
        hash_domain: "device",
        columns: &[("user_id", Hash), ("device_id", Hash), ("data", Secret)],
    },
    Table {
        name: "identity",
        hash_domain: "identity",
        columns: &[("user_id", Hash), ("data", Secret)],
    },
    Table {
        name: "tracked_user",
        hash_domain: "tracked_users",
        columns: &[("user_id", Hash), ("data", Secret)],
    },
    Table {
        name: "olm_hash",
        hash_domain: "",
        columns: &[("data", Plain)],
    },
    Table {
        name: "key_requests",
        hash_domain: "key_requests",
        columns: &[("request_id", Hash), ("sent_out", Plain), ("data", Secret)],
    },
    Table {
        name: "room_settings",
        hash_domain: "room_settings",
        columns: &[("room_id", Hash), ("data", Secret)],
    },
    Table {
        name: "direct_withheld_info",
        hash_domain: "direct_withheld_info",
        columns: &[("session_id", Hash), ("room_id", Hash), ("data", Secret)],
    },
    Table {
        name: "lease_locks",
        hash_domain: "",
        columns: &[
            ("key", Plain),
            ("holder", Plain),
            ("expiration", Plain),
            ("generation", Plain),
        ],
    },
    Table {
        name: "secrets",
        hash_domain: "secrets",
        columns: &[("secret_name", Hash), ("data", Secret)],
    },
    Table {
        name: "received_room_key_bundle",
        hash_domain: "received_room_key_bundle",
        columns: &[
            ("room_id", Hash),
            ("sender_user_id", Hash),
            ("bundle_data", Secret),
        ],
    },
];

fn open(path: &Path, flags: OpenFlags) -> Result<Connection, String> {
    Connection::open_with_flags(path, flags).map_err(super::store_error)
}

fn cipher(connection: &Connection, key: &[u8; 32]) -> Result<StoreCipher, String> {
    let serialized: Vec<u8> = connection
        .query_row("SELECT value FROM kv WHERE key = 'cipher'", [], |row| {
            row.get(0)
        })
        .map_err(super::store_error)?;
    StoreCipher::import_with_key(key, &serialized).map_err(super::store_error)
}

pub(super) fn verify_store_key(path: &Path, key: &[u8; 32]) -> Result<(), String> {
    cipher(&open(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?, key).map(|_| ())
}

fn validate_schema(connection: &Connection) -> Result<(), String> {
    let version: Vec<u8> = connection
        .query_row("SELECT value FROM kv WHERE key = 'version'", [], |row| {
            row.get(0)
        })
        .map_err(super::store_error)?;
    let table_count: usize = connection
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'",
            [],
            |row| row.get(0),
        )
        .map_err(super::store_error)?;
    if version != VERSION || table_count != TABLES.len() {
        return Err("The Matrix crypto store version is unsupported for migration.".into());
    }
    for table in TABLES {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({})", table.name))
            .map_err(super::store_error)?;
        let found = statement
            .query_map([], |row| row.get::<_, String>(1))
            .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
            .map_err(super::store_error)?;
        if !found
            .iter()
            .map(String::as_str)
            .eq(table.columns.iter().map(|(name, _)| *name))
        {
            return Err("The Matrix crypto store schema is unsupported for migration.".into());
        }
    }
    Ok(())
}

impl Table {
    fn columns(&self) -> String {
        self.columns
            .iter()
            .map(|(column, _)| format!("\"{column}\""))
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn select(&self) -> String {
        let filter = if self.name == "kv" {
            " WHERE key NOT IN ('version', 'cipher')"
        } else {
            ""
        };
        format!(
            "SELECT {} FROM {}{filter} ORDER BY rowid",
            self.columns(),
            self.name
        )
    }

    fn hash(&self, cipher: &StoreCipher, value: Value) -> Result<Value, String> {
        match value {
            Value::Blob(bytes) => Ok(Value::Blob(
                cipher.hash_key(self.hash_domain, &bytes).into(),
            )),
            Value::Null => Ok(Value::Null), // Old inbound sessions may lack a sender key.
            _ => Err("Invalid lookup value in local Matrix crypto store.".into()),
        }
    }

    fn copy(
        &self,
        source: &Connection,
        target: &Connection,
        cipher: &StoreCipher,
    ) -> Result<(), String> {
        let mut select = source.prepare(&self.select()).map_err(super::store_error)?;
        let mut rows = select.query([]).map_err(super::store_error)?;
        let parameters = vec!["?"; self.columns.len()].join(", ");
        let mut insert = target
            .prepare(&format!(
                "INSERT INTO {} ({}) VALUES ({parameters})",
                self.name,
                self.columns()
            ))
            .map_err(super::store_error)?;
        while let Some(row) = rows.next().map_err(super::store_error)? {
            let mut values = Vec::with_capacity(self.columns.len());
            for (index, (_, encoding)) in self.columns.iter().enumerate() {
                let value = match encoding {
                    Plain => row.get(index).map_err(super::store_error)?,
                    Hash => self.hash(cipher, row.get(index).map_err(super::store_error)?)?,
                    Secret => {
                        let bytes: Vec<u8> = row.get(index).map_err(super::store_error)?;
                        let encrypted = cipher
                            .encrypt_value_data(bytes)
                            .map_err(super::store_error)?;
                        Value::Blob(
                            rmp_serde::to_vec_named(&encrypted).map_err(super::store_error)?,
                        )
                    }
                };
                values.push(value);
            }
            insert
                .execute(params_from_iter(values))
                .map_err(super::store_error)?;
        }
        Ok(())
    }

    fn verify(
        &self,
        source: &Connection,
        target: &Connection,
        cipher: &StoreCipher,
    ) -> Result<(), String> {
        let mut before = source.prepare(&self.select()).map_err(super::store_error)?;
        let mut after = target.prepare(&self.select()).map_err(super::store_error)?;
        let mut before = before.query([]).map_err(super::store_error)?;
        let mut after = after.query([]).map_err(super::store_error)?;
        loop {
            let (source, target) = match (
                before.next().map_err(super::store_error)?,
                after.next().map_err(super::store_error)?,
            ) {
                (Some(source), Some(target)) => (source, target),
                (None, None) => return Ok(()),
                _ => return Err("The encrypted Matrix store has missing or extra records.".into()),
            };
            for (index, (_, encoding)) in self.columns.iter().enumerate() {
                let expected = source.get(index).map_err(super::store_error)?;
                let stored = target.get(index).map_err(super::store_error)?;
                let matches = match (encoding, expected, stored) {
                    (Plain, expected, stored) => expected == stored,
                    (Hash, expected, stored) => self.hash(cipher, expected)? == stored,
                    (Secret, Value::Blob(expected), Value::Blob(stored)) => {
                        let expected = Zeroizing::new(expected);
                        let encrypted =
                            rmp_serde::from_slice(&stored).map_err(super::store_error)?;
                        let actual = Zeroizing::new(
                            cipher
                                .decrypt_value_data(encrypted)
                                .map_err(super::store_error)?,
                        );
                        *expected == *actual
                    }
                    _ => false,
                };
                if !matches {
                    return Err(
                        "A migrated Matrix crypto record did not match the original.".into(),
                    );
                }
            }
        }
    }
}

pub(super) fn copy_and_verify(source: &Path, target: &Path, key: &[u8; 32]) -> Result<(), String> {
    let mut source = open(source, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let source = source
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(super::store_error)?;
    validate_schema(&source)?;
    let source_encrypted: bool = source
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM kv WHERE key = 'cipher')",
            [],
            |row| row.get(0),
        )
        .map_err(super::store_error)?;
    if source_encrypted {
        return Err(
            "The original Matrix store is already encrypted in an unexpected location.".into(),
        );
    }
    {
        let mut target = open(target, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        validate_schema(&target)?;
        let cipher = cipher(&target, key)?;
        target
            .pragma_update(None, "synchronous", "FULL")
            .map_err(super::store_error)?;
        let copy = target.transaction().map_err(super::store_error)?;
        for table in TABLES {
            table.copy(&source, &copy, &cipher)?;
        }
        copy.commit().map_err(super::store_error)?;
        target
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(super::store_error)?;
    }
    let target = open(target, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let cipher = cipher(&target, key)?;
    for table in TABLES {
        table.verify(&source, &target, &cipher)?;
    }
    Ok(())
}
