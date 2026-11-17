//! Direct relationships from the local sync store. Sidebar flattening is a
//! presentation concern; notification inheritance uses these direct edges.

use std::{
    collections::{BTreeMap, HashMap},
    time::Duration,
};

use futures_util::{stream, StreamExt, TryStreamExt};
use matrix_sdk::{ruma::events::StateEventType, Client, Room};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpaceChildMeta {
    pub child_id: String,
    pub order: Option<String>,
    pub origin_server_ts: u64,
}

pub(crate) type SpaceChildren = HashMap<String, Vec<SpaceChildMeta>>;
pub(crate) type ParentSpaces = HashMap<String, BTreeMap<String, SpaceChildMeta>>;

/// Index once per snapshot rather than scanning every space's children for
/// each room. Sorted parent IDs also give consumers a stable precedence.
pub(crate) fn index_parent_spaces(children: &SpaceChildren) -> ParentSpaces {
    let mut parents = ParentSpaces::new();
    for (space, children) in children {
        for child in children {
            parents
                .entry(child.child_id.clone())
                .or_default()
                .insert(space.clone(), child.clone());
        }
    }
    parents
}

fn parse_child(value: &Value) -> Option<SpaceChildMeta> {
    let child_id = value.get("state_key")?.as_str()?;
    matrix_sdk::ruma::RoomId::parse(child_id).ok()?;
    // Empty content, missing/empty via, and redacted events remove the edge.
    let content = value.get("content")?;
    if content.get("via")?.as_array()?.is_empty() {
        return None;
    }
    Some(SpaceChildMeta {
        child_id: child_id.to_owned(),
        order: content
            .get("order")
            .and_then(Value::as_str)
            .map(str::to_owned),
        origin_server_ts: value
            .get("origin_server_ts")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

pub(crate) async fn load_space_children(room: &Room) -> Result<Vec<SpaceChildMeta>, String> {
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        room.get_state_events(StateEventType::SpaceChild),
    )
    .await
    .map_err(|_| format!("Space-child read timed out: {}", room.room_id()))?
    .map_err(|e| format!("Space-child read failed for {}: {e}", room.room_id()))?;
    let mut children = Vec::new();
    for event in events {
        use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
        let value = match event {
            RawAnySyncOrStrippedState::Sync(raw) => raw.deserialize_as::<Value>(),
            RawAnySyncOrStrippedState::Stripped(raw) => raw.deserialize_as::<Value>(),
        }
        .map_err(|e| format!("Invalid space-child event in {}: {e}", room.room_id()))?;
        if let Some(child) = parse_child(&value) {
            children.push(child);
        }
    }
    Ok(children)
}

/// Fail the snapshot on a store error: unavailable relationships must not be
/// interpreted as removed relationships when projecting notification rules.
pub(crate) async fn load_space_graph(client: &Client) -> Result<SpaceChildren, String> {
    stream::iter(
        client
            .joined_rooms()
            .into_iter()
            .filter(|room| room.is_space())
            .map(|room| async move {
                let children = load_space_children(&room).await?;
                Ok::<_, String>((room.room_id().to_string(), children))
            }),
    )
    .buffer_unordered(16)
    .try_collect()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn active_child_preserves_order_and_timestamp() {
        assert_eq!(
            parse_child(&json!({"state_key":"!child:example.org", "content":{
            "via":["example.org"], "order":"abc"}, "origin_server_ts":42})),
            Some(SpaceChildMeta {
                child_id: "!child:example.org".into(),
                order: Some("abc".into()),
                origin_server_ts: 42,
            })
        );
    }

    #[test]
    fn deleted_redacted_and_invalid_children_are_not_edges() {
        for content in [json!({}), json!({"via":[]}), json!({"via":null})] {
            assert!(
                parse_child(&json!({"state_key":"!child:example.org", "content":content}))
                    .is_none()
            );
        }
        assert!(
            parse_child(&json!({"state_key":"invalid", "content":{"via":["example.org"]}}))
                .is_none()
        );
    }

    #[test]
    fn stripped_child_does_not_need_a_timestamp() {
        let child = parse_child(
            &json!({"state_key":"!child:example.org", "content":{"via":["example.org"]}}),
        )
        .unwrap();
        assert_eq!(child.origin_server_ts, 0);
        assert_eq!(child.order, None);
    }

    #[test]
    fn parent_index_keeps_metadata_and_only_direct_edges_in_stable_order() {
        let child = parse_child(
            &json!({"state_key":"!room:server", "content":{"via":["server"], "order":"one"}}),
        )
        .unwrap();
        let subspace =
            parse_child(&json!({"state_key":"!sub:server", "content":{"via":["server"]}})).unwrap();
        let children = SpaceChildren::from([
            ("!z:server".into(), vec![child.clone()]),
            ("!a:server".into(), vec![child.clone(), subspace]),
            (
                "!sub:server".into(),
                vec![parse_child(
                    &json!({"state_key":"!nested:server", "content":{"via":["server"]}}),
                )
                .unwrap()],
            ),
        ]);
        let parents = index_parent_spaces(&children);
        assert_eq!(
            parents["!room:server"]
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["!a:server", "!z:server"]
        );
        assert_eq!(parents["!room:server"]["!a:server"], child);
        assert_eq!(
            parents["!nested:server"]
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["!sub:server"]
        );
    }
}
