import type { RoomMember } from "../types/matrix";

export type MemberPresenceUpdate = Pick<RoomMember, "userId" | "presence" | "statusMsg">;
export type MemberLabelResolver = (userId: string) => string;
export type RoomMemberSnapshot = {
  members: RoomMember[];
  loading: boolean;
  error: string | null;
  resolveMemberLabel: MemberLabelResolver;
};

type Options = {
  load: (roomId: string) => Promise<RoomMember[]>;
  onMembers?: (members: RoomMember[]) => void;
  debounceMs?: number;
  maxCachedRooms?: number;
};
type Flight = { epoch: number; revision: number; presenceRevision: number };
type Entry = {
  snapshot: RoomMemberSnapshot;
  listeners: Set<() => void>;
  memberIds: Set<string>;
  labels: Map<string, string>;
  loaded: boolean;
  dirty: boolean;
  revision: number;
  flight: Flight | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const keyForUser = (userId: string) => userId.trim().toLowerCase();
const fallbackLabel: MemberLabelResolver = (userId) => userId;
const emptySnapshot: RoomMemberSnapshot = {
  members: [], loading: false, error: null, resolveMemberLabel: fallbackLabel,
};

function sameMember(a: RoomMember, b: RoomMember): boolean {
  return a.userId === b.userId && a.displayName === b.displayName && a.avatarUrl === b.avatarUrl
    && a.presence === b.presence && a.statusMsg === b.statusMsg;
}

/** One request and subscription resource per room, owned by the authenticated session. */
export class RoomMemberStore {
  private rooms = new Map<string, Entry>();
  private presence = new Map<string, MemberPresenceUpdate & { revision: number }>();
  private presenceRevision = 0;
  private active = false;
  private epoch = 0;
  private options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  private entry(roomId: string): Entry {
    let entry = this.rooms.get(roomId);
    if (!entry) {
      entry = {
        snapshot: { ...emptySnapshot, loading: true },
        listeners: new Set(), memberIds: new Set(), labels: new Map(),
        loaded: false, dirty: true, revision: 0, flight: null, timer: null,
      };
      this.rooms.set(roomId, entry);
    }
    return entry;
  }

  getSnapshot(roomId: string): RoomMemberSnapshot {
    // Draft DMs do not have a Matrix membership list yet.
    return roomId.startsWith("!") ? this.entry(roomId).snapshot : emptySnapshot;
  }

  subscribe(roomId: string, listener: () => void): () => void {
    if (!roomId.startsWith("!")) return () => {};
    const entry = this.entry(roomId);
    if (!entry.listeners.size && !entry.flight) entry.dirty = true;
    entry.listeners.add(listener);
    this.rooms.delete(roomId);
    this.rooms.set(roomId, entry);
    this.schedule(roomId, entry);
    this.trimCache();
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      this.trimCache();
    };
  }

  private publish(entry: Entry, snapshot: RoomMemberSnapshot): void {
    if (entry.snapshot === snapshot) return;
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
  }

  invalidate(roomId: string): void {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.revision += 1;
    entry.dirty = true;
    this.schedule(roomId, entry);
  }

  invalidateAll(): void {
    for (const roomId of this.rooms.keys()) this.invalidate(roomId);
  }

  private schedule(roomId: string, entry: Entry): void {
    if (!this.active || !entry.listeners.size || !entry.dirty || entry.flight || entry.timer !== null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.refresh(roomId, entry);
    }, entry.loaded ? this.options.debounceMs ?? 50 : 0);
  }

  private async refresh(roomId: string, entry: Entry): Promise<void> {
    if (!this.active || !entry.listeners.size || entry.flight) return;
    const flight: Flight = { epoch: this.epoch, revision: entry.revision, presenceRevision: this.presenceRevision };
    entry.flight = flight;
    entry.dirty = false;
    if (!entry.loaded && !entry.snapshot.loading) {
      this.publish(entry, { ...entry.snapshot, loading: true, error: null });
    }
    try {
      const result = await this.options.load(roomId);
      if (!this.active || flight.epoch !== this.epoch || flight.revision !== entry.revision) return;

      const byId = new Map(result.map((member) => [keyForUser(member.userId), member]));
      const oldById = new Map(entry.snapshot.members.map((member) => [keyForUser(member.userId), member]));
      const members = [...byId.values()].map((member) => {
        const patch = this.presence.get(keyForUser(member.userId));
        // Only overlay events received during this query. Older presence must
        // not override a newer snapshot returned by the backend.
        const next = patch && patch.revision > flight.presenceRevision
          ? { ...member, presence: patch.presence, statusMsg: patch.statusMsg } : member;
        const old = oldById.get(keyForUser(member.userId));
        return old && sameMember(old, next) ? old : next;
      }).sort((a, b) => keyForUser(a.userId).localeCompare(keyForUser(b.userId)));

      const labels = new Map(members.map((member) => [
        keyForUser(member.userId), (member.displayName?.trim() || member.userId).trim(),
      ]));
      const labelsChanged = labels.size !== entry.labels.size
        || [...labels].some(([id, label]) => entry.labels.get(id) !== label);
      const resolveMemberLabel = labelsChanged
        ? (userId: string) => labels.get(keyForUser(userId)) ?? userId
        : entry.snapshot.resolveMemberLabel;
      const old = entry.snapshot;
      const sameMembers = members.length === old.members.length
        && members.every((member, index) => member === old.members[index]);
      entry.memberIds = new Set(byId.keys());
      entry.labels = labels;
      entry.loaded = true;
      this.options.onMembers?.(members);
      if (!sameMembers || old.loading || old.error !== null || labelsChanged) {
        this.publish(entry, { members: sameMembers ? old.members : members, loading: false, error: null, resolveMemberLabel });
      }
    } catch (error) {
      if (this.active && flight.epoch === this.epoch && flight.revision === entry.revision) {
        this.publish(entry, { ...entry.snapshot, loading: false, error: String(error) });
      }
    } finally {
      if (flight.epoch === this.epoch && entry.flight === flight) {
        entry.flight = null;
        // A change received during the request must get another pass.
        this.schedule(roomId, entry);
        this.trimCache();
      }
    }
  }

  /** Provider batches presence per animation frame; it never triggers membership IO or sorting. */
  applyPresence(updates: Iterable<MemberPresenceUpdate>): void {
    if (!this.active) return;
    this.presenceRevision += 1;
    const patches = new Map([...updates].map((patch) => [keyForUser(patch.userId), patch]));
    const fetching = [...this.rooms.values()].some((entry) => entry.flight !== null);
    for (const [id, patch] of patches) {
      if (fetching || [...this.rooms.values()].some((entry) => entry.memberIds.has(id))) {
        this.presence.set(id, { ...patch, revision: this.presenceRevision });
      }
    }
    for (const entry of this.rooms.values()) {
      if (![...patches.keys()].some((id) => entry.memberIds.has(id))) continue;
      let changed = false;
      const members = entry.snapshot.members.map((member) => {
        const patch = patches.get(keyForUser(member.userId));
        if (!patch || (member.presence === patch.presence && member.statusMsg === patch.statusMsg)) return member;
        changed = true;
        return { ...member, presence: patch.presence, statusMsg: patch.statusMsg };
      });
      if (changed) this.publish(entry, { ...entry.snapshot, members });
    }
  }

  private trimCache(): void {
    const limit = this.options.maxCachedRooms ?? 32;
    for (const [roomId, entry] of this.rooms) {
      if (this.rooms.size <= limit) break;
      if (!entry.listeners.size && !entry.flight) this.rooms.delete(roomId);
    }
    if ([...this.rooms.values()].some((entry) => entry.flight !== null)) return;
    const knownUsers = new Set([...this.rooms.values()].flatMap((entry) => [...entry.memberIds]));
    for (const id of this.presence.keys()) if (!knownUsers.has(id)) this.presence.delete(id);
  }

  /** Called only after the provider has registered event listeners. */
  start(): void {
    this.active = true;
    this.invalidateAll();
  }

  dispose(): void {
    this.active = false;
    this.epoch += 1;
    this.presence.clear();
    for (const entry of this.rooms.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      entry.flight = null;
      entry.dirty = true;
    }
  }
}
