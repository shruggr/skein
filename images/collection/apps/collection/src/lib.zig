//! The collection overlay's library (shruggr/skein#151), the module
//! `collection` of the skein-collection package, over skein-1sat's parsers
//! and the SDK's `chain` (bsvz):
//!
//!   name    topic and lookup names, collection ids `<txid>_<vout>`, relative ids
//!   mint    collection and item mints: MAP fields, the signer, the item's checks
//!   rules   the topics' verdict on one transaction (the admitted set, rules 1 to 4)
//!
//! The topic manager (src/collection_topic.zig) and the lookup
//! (src/collection_lookup.zig) are built on it.
pub const name = @import("name.zig");
pub const mint = @import("mint.zig");
pub const rules = @import("rules.zig");

test {
    @import("std").testing.refAllDecls(@This());
}
