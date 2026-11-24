import type { CallPermissions } from "./useRoomCallPermissions";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DirectCall } from "./useDirectCall";
import { applyGroupResponse, type GroupResponse } from "./groupCallResponses";
import type { VoiceCall } from "./useVoiceCall";

interface GroupSignal extends Omit<GroupResponse, "kind"> {
  video?: boolean;
  kind: "ring" | GroupResponse["kind"];
  silent: boolean;
  callId: string;
  expiresAt: number;
}

interface GroupSession {
  call: DirectCall;
  outgoing: boolean;
  invitees: Set<string>;
  declined: Set<string>;
  ring?: Promise<{ eventId: string; invitees: string[] }>;
}

function respond(roomId: string, ringEventId: string, action: "cancel" | "answer" | "decline") {
  return invoke<void>("respond_to_group_call", { roomId, ringEventId, action });
}

export function useGroupCall(
  voice: VoiceCall,
  current: RefObject<DirectCall | null>,
  busy: RefObject<boolean>,
  update: (call: DirectCall | null) => void,
  setError: (error: string | null) => void,
  ready: boolean,
  dismissQuiet: RefObject<() => void>,
) {
  const session = useRef<GroupSession | null>(null);
  const { connect, disconnect } = voice;
  const publish = useCallback((group: GroupSession, changes: Partial<DirectCall>) => {
    group.call = { ...group.call, ...changes };
    update(group.call);
  }, [update]);

  const finish = useCallback((notify: boolean) => {
    const group = session.current;
    if (!group) return Promise.resolve();
    session.current = null;
    update(null);
    const { roomId, phase, ringEventId } = group.call;
    if (notify) {
      // A quick cancel can race the homeserver's response to our ring.
      if (group.outgoing && group.ring) {
        void group.ring.then(({ eventId }) => respond(roomId, eventId, "cancel")).catch(console.warn);
      } else if (!group.outgoing && phase === "incoming" && ringEventId) {
        void respond(roomId, ringEventId, "decline").catch(console.warn);
      }
    }
    return phase === "incoming" ? Promise.resolve() : disconnect(roomId);
  }, [disconnect, update]);

  const start = useCallback((roomId: string, userId: string, video = false) => {
    dismissQuiet.current();
    if (current.current || busy.current) return;
    const group: GroupSession = {
      call: { callId: crypto.randomUUID(), roomId, peerUserId: userId, transport: "group",
        phase: "connecting", video, expiresAt: Date.now() + 60_000 },
      outgoing: true, invitees: new Set(), declined: new Set(),
    };
    session.current = group;
    setError(null);
    update(group.call);
    void (async () => {
      const permissions = await invoke<CallPermissions>("get_room_call_permissions", { roomId, checkGroup: true });
      if (session.current !== group) return;
      if (!permissions.group) throw new Error("Your role cannot ring a group call in this room.");
      let membershipEventId: string | undefined;
      const connected = await connect(roomId, { replaceOtherSessions: false, onJoined: (id) => { membershipEventId = id; } });
      if (session.current !== group) return;
      if (!connected || !membershipEventId) throw new Error("Could not join the group voice session.");
      group.ring = invoke("ring_group_call", { roomId, membershipEventId, video });
      const ring = await group.ring;
      if (session.current !== group) return;
      group.invitees = new Set(ring.invitees);
      publish(group, { ringEventId: ring.eventId, phase: "dialing", expiresAt: Date.now() + 30_000 });
    })().catch((reason) => {
      if (session.current === group) { void finish(true); setError(String(reason)); }
    });
  }, [busy, connect, current, dismissQuiet, finish, publish, setError, update]);

  const answer = useCallback((onStarted?: (roomId: string) => void) => {
    const group = session.current;
    if (!group || group.call.phase !== "incoming" || group.call.expiresAt <= Date.now() || busy.current) return;
    const { roomId, ringEventId, expiresAt } = group.call;
    publish(group, { phase: "answering", expiresAt: Date.now() + 60_000 });
    onStarted?.(roomId);
    void (async () => {
      const joined = await connect(roomId, { replaceOtherSessions: false });
      if (session.current !== group) return;
      if (!joined) throw new Error("Could not join the group voice session.");
      publish(group, { phase: "active", established: true, connectedAt: Date.now(), expiresAt });
      // The membership carries audio. This response dismisses the ring on our other devices.
      void respond(roomId, ringEventId!, "answer").catch(console.warn);
    })().catch((reason) => {
      if (session.current === group) { void finish(false); setError(String(reason)); }
    });
  }, [busy, connect, finish, publish, setError]);

  const receive = useCallback(async (event: GroupSignal) => {
    const group = session.current;
    if (event.kind === "ring") {
      if (busy.current || event.expiresAt <= Date.now()) return;
      if (!event.silent) dismissQuiet.current();
      if (current.current) return;
      const call: DirectCall = { callId: event.callId, roomId: event.roomId, peerUserId: event.sender,
        phase: "incoming", video: event.video, silent: event.silent, transport: "group", expiresAt: event.expiresAt, ringEventId: event.ringEventId };
      session.current = { call, outgoing: false, invitees: new Set(), declined: new Set() };
      setError(null);
      update(call);
      return;
    }
    if (!group || group.call.roomId !== event.roomId) return;
    // Sync can deliver a fast response before the ring send returns its event ID.
    if (group.outgoing && !group.call.ringEventId && group.ring) await group.ring;
    if (session.current !== group) return;
    switch (applyGroupResponse(group, { ...event, kind: event.kind })) {
      case "dismiss":
        void finish(false);
        break;
      case "answered":
        publish(group, { phase: "active", established: true, connectedAt: Date.now() });
        break;
      case "allDeclined":
        void finish(true);
        setError("Everyone declined the call.");
        break;
    }
  }, [busy, current, dismissQuiet, finish, publish, setError, update]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let reads = Promise.resolve();
    const drain = () => {
      reads = reads.then(async () => {
        if (disposed) return;
        const signals = await invoke<GroupSignal[]>("take_group_call_signals");
        for (const signal of signals) {
          if (disposed) return;
          await receive(signal);
        }
      }).catch(console.warn);
    };
    const subscription = listen("group-call-signals", drain);
    void subscription.then(drain).catch(console.warn);
    return () => { disposed = true; void subscription.then((remove) => remove()).catch(console.warn); };
  }, [ready, receive]);

  const call = session.current?.call;
  const hasPeer = !!voice.remoteParticipants.length;
  useEffect(() => {
    const group = session.current;
    if (!group || !call || group.call !== call) return;
    if (call.phase !== "incoming" && voice.endedRoomId === call.roomId && !voice.targetRoomId) {
      void finish(true);
      return;
    }
    if (call.phase === "dialing" && hasPeer && voice.connectedRoomId === call.roomId) {
      publish(group, { phase: "active", established: true, connectedAt: Date.now() });
      return;
    }
    if (call.phase === "active" && (hasPeer || voice.isReconnecting)) return;
    // Leave time for an outstanding invite to be answered after the first participant leaves.
    const delay = Math.max(call.phase === "active" ? 5_000 : 0, call.expiresAt - Date.now());
    const timer = setTimeout(() => {
      if (session.current !== group || group.call !== call) return;
      void finish(group.outgoing);
      if (call.phase === "dialing") setError("No answer.");
      else if (call.phase === "connecting" || call.phase === "answering") setError("The group call connection timed out.");
    }, delay);
    return () => clearTimeout(timer);
  }, [call, finish, hasPeer, publish, setError, voice.connectedRoomId, voice.endedRoomId, voice.isReconnecting, voice.targetRoomId]);

  const silence = useCallback((silent: boolean) => {
    const group = session.current;
    if (group?.call.phase === "incoming") publish(group, { silent });
  }, [publish]);

  return { start, answer, finish, silence };
}
