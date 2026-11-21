import type { Message } from "../../../types/matrix";

export function hidesMessage(message: Message, ignoredUsers: ReadonlySet<string>) {
  return !message.membershipNotice && ignoredUsers.has(message.sender);
}

export function projectMessages(
  messages: Message[],
  ignoredUsers: ReadonlySet<string>,
  ignoreListRevision: number | null = null,
): Message[] {
  if (!ignoredUsers.size) return messages;
  return messages.filter((message) => !hidesMessage(message, ignoredUsers)).map((message) => {
    let reactions = message.reactions;
    if (reactions?.some((reaction) => reaction.reactedBy?.some((id) => ignoredUsers.has(id)))) {
      reactions = reactions.flatMap((reaction) => {
        if (!reaction.reactedBy) return [reaction];
        const reactedBy = reaction.reactedBy.filter((id) => !ignoredUsers.has(id));
        if (reactedBy.length === reaction.reactedBy.length) return [reaction];
        const count = reaction.count - (reaction.reactedBy.length - reactedBy.length);
        return count > 0 ? [{ ...reaction, count, reactedBy }] : [];
      });
    }
    // A fresh server bundle already excludes ignored replies. Cached bundles
    // have no complete list of senders, so count the visible replies instead.
    const summary = message.threadSummary;
    const threadSummary = summary?.ignoreListRevision === ignoreListRevision ? summary : undefined;
    if (reactions === message.reactions && threadSummary === summary) return message;
    return { ...message, reactions, threadSummary };
  });
}
