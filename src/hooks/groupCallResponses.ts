export interface GroupResponse {
  kind: "cancel" | "answer" | "decline";
  sender: string;
  fromSelf: boolean;
  roomId: string;
  ringEventId: string;
}

interface GroupRing {
  outgoing: boolean;
  invitees: Set<string>;
  declined: Set<string>;
  call: { roomId: string; ringEventId?: string; peerUserId: string; phase: string };
}

export function applyGroupResponse(group: GroupRing, event: GroupResponse) {
  const { call } = group;
  if (event.roomId !== call.roomId || event.ringEventId !== call.ringEventId) return;
  if (!group.outgoing) {
    if (call.phase !== "incoming" && call.phase !== "answering") return;
    if (event.kind === "cancel" && event.sender === call.peerUserId) return "dismiss";
    if (event.fromSelf && (event.kind === "decline" || event.kind === "answer")) return "dismiss";
    return;
  }
  if (call.phase !== "dialing" || !group.invitees.has(event.sender)) return;
  if (event.kind === "answer") return "answered";
  if (event.kind === "decline") {
    group.declined.add(event.sender);
    if (group.declined.size === group.invitees.size) return "allDeclined";
  }
}
