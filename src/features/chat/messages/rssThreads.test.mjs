import assert from "node:assert/strict";
import test from "node:test";
import { mergeThreadReplies, partitionRssTimeline, rssThreadReplyCount } from "./rssThreads.ts";

function message(eventId, fields = {}) {
  return { eventId, body: eventId, timestamp: 1, ...fields };
}

const root = message("$article");
const articles = new Map([[root.eventId, { root, article: { url: "https://example.org/story" } }]]);

test("the room shows the article while native and earlier regular replies share a drawer", () => {
  const legacy = message("$legacy", { replyTo: { eventId: root.eventId } });
  const native = message("$thread", { threadRootId: root.eventId, replyTo: { eventId: legacy.eventId } });
  const followUp = message("$followup", { replyTo: { eventId: legacy.eventId } });
  const ordinary = message("$ordinary");
  const ordinaryReply = message("$normal", { replyTo: { eventId: ordinary.eventId } });
  const otherThread = message("$other-thread", { threadRootId: ordinary.eventId });
  const { visibleMessages, replies, rootByReply } = partitionRssTimeline(
    [root, legacy, ordinary, native, ordinaryReply, followUp, otherThread],
    articles,
  );
  assert.deepEqual(visibleMessages, [root, ordinary, ordinaryReply, otherThread]);
  assert.deepEqual(replies.get(root.eventId), [legacy, native, followUp]);
  assert.equal(rootByReply.get(native.eventId), root.eventId);
  assert.equal(rssThreadReplyCount(root, replies.get(root.eventId)), 3);
});

test("an RSS reply stays out of the timeline if its root is on a different page", () => {
  const native = message("$thread", { threadRootId: root.eventId });
  const ancestor = message("$old-reply", { replyTo: { eventId: root.eventId } });
  const followUp = message("$followup", { replyTo: { eventId: ancestor.eventId } });
  const result = partitionRssTimeline([native, followUp], articles, new Map([[ancestor.eventId, ancestor]]));
  assert.deepEqual(result.visibleMessages, []);
  assert.deepEqual(result.replies.get(root.eventId), [native, followUp]);
});

test("a server bundle and sync echo are counted once, while new replies increase the count", () => {
  const article = { ...root, threadSummary: { count: 12, latestEventId: "$last", latestTimestamp: 20 } };
  const bundled = message("$last", { timestamp: 20, threadRootId: root.eventId });
  const sent = message("$sent", { timestamp: 30, threadRootId: root.eventId });
  const synced = { ...sent, timestamp: 32, body: "new reply" };
  const legacy = message("$legacy", { timestamp: 5, replyTo: { eventId: root.eventId } });
  const replies = mergeThreadReplies([bundled, sent, legacy], [synced]);
  assert.deepEqual(replies, [legacy, bundled, synced]);
  assert.equal(rssThreadReplyCount(article, replies), 14);
});

test("an attachment's upload stays in the thread and counts once the send is accepted", () => {
  const pending = message("local:upload", {
    threadRootId: root.eventId,
    localFileUpload: { phase: "uploading", progress: 0.5 },
  });
  const result = partitionRssTimeline([root, pending], articles);
  assert.deepEqual(result.visibleMessages, [root]);
  assert.deepEqual(result.replies.get(root.eventId), [pending]);
  assert.equal(rssThreadReplyCount(root, [pending]), 0);
  assert.equal(rssThreadReplyCount(root, [{ ...pending, eventId: "$attachment" }]), 1);
});
