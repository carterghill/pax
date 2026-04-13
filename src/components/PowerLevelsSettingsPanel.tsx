import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

export interface RoomPowerLevelsSettingsResponse {
  content: Record<string, unknown>;
  canEdit: boolean;
  userPowerLevel: number;
  isSpace: boolean;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function clampPl(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function readTopLevel(content: Record<string, unknown>, key: string, fallback: number): number {
  const v = content[key];
  if (typeof v === "number" && Number.isFinite(v)) return clampPl(v);
  return fallback;
}

function readStateDefault(content: Record<string, unknown>): number {
  return readTopLevel(content, "state_default", 50);
}

function readEventLevel(
  content: Record<string, unknown>,
  eventType: string,
  stateDefault: number,
): number {
  const ev = content.events;
  if (isRecord(ev)) {
    const v = ev[eventType];
    if (typeof v === "number" && Number.isFinite(v)) return clampPl(v);
  }
  return stateDefault;
}

function readNotificationsRoom(content: Record<string, unknown>): number {
  const n = content.notifications;
  if (isRecord(n)) {
    const r = n.room;
    if (typeof r === "number" && Number.isFinite(r)) return clampPl(r);
  }
  return 50;
}

/** Matrix `m.room.power_levels` event types we expose (state events use `events` map). */
const ROOM_STATE_EVENT_KEYS: { key: string; label: string }[] = [
  { key: "m.room.name", label: "Room name" },
  { key: "m.room.avatar", label: "Room avatar" },
  { key: "m.room.topic", label: "Room topic" },
  { key: "m.room.canonical_alias", label: "Main address (canonical alias)" },
  { key: "m.room.history_visibility", label: "History visibility" },
  { key: "m.room.join_rules", label: "Join rules & directory listing" },
  { key: "m.room.guest_access", label: "Guest access" },
  { key: "m.room.power_levels", label: "Power levels (this setting)" },
  { key: "m.room.encryption", label: "Encryption" },
  { key: "m.room.server_acl", label: "Server ACL" },
  { key: "m.room.pinned_events", label: "Pinned messages" },
  { key: "m.room.tombstone", label: "Room upgrade (tombstone)" },
];

const SPACE_STATE_EVENT_KEYS: { key: string; label: string }[] = [
  { key: "m.space.child", label: "Add or remove rooms & sub-spaces" },
  { key: "m.space.parent", label: "Link parent space" },
];

type Draft = {
  ban: number;
  kick: number;
  redact: number;
  invite: number;
  eventsDefault: number;
  stateDefault: number;
  usersDefault: number;
  notificationsRoom: number;
  eventLevels: Record<string, number>;
};

function contentToDraft(content: Record<string, unknown>, isSpace: boolean): Draft {
  const stateDefault = readStateDefault(content);
  const keys = [
    ...ROOM_STATE_EVENT_KEYS.map((r) => r.key),
    ...(isSpace ? SPACE_STATE_EVENT_KEYS.map((r) => r.key) : []),
  ];
  const eventLevels: Record<string, number> = {};
  for (const k of keys) {
    eventLevels[k] = readEventLevel(content, k, stateDefault);
  }
  return {
    ban: readTopLevel(content, "ban", 50),
    kick: readTopLevel(content, "kick", 50),
    redact: readTopLevel(content, "redact", 50),
    invite: readTopLevel(content, "invite", 50),
    eventsDefault: readTopLevel(content, "events_default", 0),
    stateDefault,
    usersDefault: readTopLevel(content, "users_default", 0),
    notificationsRoom: readNotificationsRoom(content),
    eventLevels,
  };
}

function draftEquals(a: Draft, b: Draft): boolean {
  if (
    a.ban !== b.ban ||
    a.kick !== b.kick ||
    a.redact !== b.redact ||
    a.invite !== b.invite ||
    a.eventsDefault !== b.eventsDefault ||
    a.stateDefault !== b.stateDefault ||
    a.usersDefault !== b.usersDefault ||
    a.notificationsRoom !== b.notificationsRoom
  ) {
    return false;
  }
  const keys = new Set([...Object.keys(a.eventLevels), ...Object.keys(b.eventLevels)]);
  for (const k of keys) {
    if (a.eventLevels[k] !== b.eventLevels[k]) return false;
  }
  return true;
}

function buildContentFromDraft(
  base: Record<string, unknown>,
  draft: Draft,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  out.ban = draft.ban;
  out.kick = draft.kick;
  out.redact = draft.redact;
  out.invite = draft.invite;
  out.events_default = draft.eventsDefault;
  out.state_default = draft.stateDefault;
  out.users_default = draft.usersDefault;

  const prevEvents = isRecord(out.events) ? { ...out.events } : {};
  for (const [k, v] of Object.entries(draft.eventLevels)) {
    prevEvents[k] = v;
  }
  out.events = prevEvents;

  const prevN = isRecord(out.notifications) ? { ...out.notifications } : {};
  prevN.room = draft.notificationsRoom;
  out.notifications = prevN;

  return out;
}

function LevelField({
  id,
  label,
  description,
  value,
  disabled,
  onChange,
  palette,
  typography,
  spacing,
}: {
  id: string;
  label: string;
  description?: string;
  value: number;
  disabled: boolean;
  onChange: (n: number) => void;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  spacing: ReturnType<typeof useTheme>["spacing"];
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: spacing.unit * 2,
        alignItems: "start",
        padding: `${spacing.unit * 2}px 0`,
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <label
          htmlFor={id}
          style={{
            fontSize: typography.fontSizeSmall,
            fontWeight: typography.fontWeightMedium,
            color: palette.textHeading,
            display: "block",
          }}
        >
          {label}
        </label>
        {description && (
          <div
            style={{
              fontSize: 12,
              color: palette.textSecondary,
              marginTop: 2,
              lineHeight: 1.35,
            }}
          >
            {description}
          </div>
        )}
      </div>
      <input
        id={id}
        type="number"
        min={0}
        max={100}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          onChange(Number.isFinite(n) ? clampPl(n) : 0);
        }}
        style={{
          width: 72,
          padding: "6px 8px",
          fontSize: typography.fontSizeSmall,
          fontFamily: typography.fontFamily,
          backgroundColor: palette.bgTertiary,
          border: `1px solid ${palette.border}`,
          borderRadius: 6,
          color: palette.textPrimary,
          opacity: disabled ? 0.5 : 1,
        }}
      />
    </div>
  );
}

function SectionTitle({
  children,
  palette,
  typography,
}: {
  children: ReactNode;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
}) {
  return (
    <h3
      style={{
        margin: "16px 0 8px 0",
        fontSize: typography.fontSizeBase,
        fontWeight: typography.fontWeightBold,
        color: palette.textHeading,
      }}
    >
      {children}
    </h3>
  );
}

export default function PowerLevelsSettingsPanel({
  roomId,
  onSaved,
}: {
  roomId: string;
  onSaved?: () => void | Promise<void>;
}) {
  const { palette, typography, spacing } = useTheme();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [userPl, setUserPl] = useState(0);
  const [isSpace, setIsSpace] = useState(false);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseContent, setBaseContent] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaveError(null);
    setSuccess(false);
    try {
      const res = await invoke<RoomPowerLevelsSettingsResponse>("get_room_power_levels_settings", {
        roomId,
      });
      const c = res.content;
      setCanEdit(res.canEdit);
      setUserPl(res.userPowerLevel);
      setIsSpace(res.isSpace);
      setBaseContent(c);
      const d = contentToDraft(c, res.isSpace);
      setBaseline(d);
      setDraft(d);
    } catch (e) {
      setError(String(e));
      setBaseline(null);
      setDraft(null);
      setBaseContent(null);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return !draftEquals(draft, baseline);
  }, [draft, baseline]);

  const disabled = !canEdit || saving;

  const updateDraft = useCallback((patch: Partial<Draft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const updateEventLevel = useCallback((key: string, n: number) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        eventLevels: { ...prev.eventLevels, [key]: n },
      };
    });
  }, []);

  const handleSave = async () => {
    if (!draft || !baseContent || !canEdit) return;
    setSaving(true);
    setSaveError(null);
    setSuccess(false);
    try {
      const body = buildContentFromDraft(baseContent, draft);
      await invoke("set_room_power_levels", { roomId, content: body });
      setSuccess(true);
      await load();
      await onSaved?.();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (baseline) setDraft(baseline);
    setSaveError(null);
    setSuccess(false);
  };

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
          padding: spacing.unit * 3,
        }}
      >
        <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
        Loading power levels…
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div
        style={{
          padding: spacing.unit * 3,
          borderRadius: 8,
          border: "1px solid rgba(237,66,69,0.35)",
          backgroundColor: "rgba(237,66,69,0.12)",
          color: "#ed4245",
          fontSize: typography.fontSizeSmall,
        }}
      >
        {error ?? "Failed to load power levels."}
      </div>
    );
  }

  return (
    <div>
      <p
        style={{
          margin: "0 0 12px 0",
          fontSize: typography.fontSizeSmall,
          color: palette.textSecondary,
          lineHeight: 1.45,
        }}
      >
        Minimum power level required for each action (0–100). Typical roles:{" "}
        <strong style={{ color: palette.textHeading }}>0</strong> member,{" "}
        <strong style={{ color: palette.textHeading }}>50</strong> moderator,{" "}
        <strong style={{ color: palette.textHeading }}>100</strong> admin. State events fall back to
        “Default for state events” when not set.
      </p>
      <div
        style={{
          fontSize: typography.fontSizeSmall,
          color: palette.textSecondary,
          marginBottom: spacing.unit * 2,
        }}
      >
        Your power level:{" "}
        <span style={{ color: palette.textHeading, fontWeight: typography.fontWeightMedium }}>
          {userPl}
        </span>
        {!canEdit && (
          <span style={{ marginLeft: 8, color: "#ed4245" }}>
            You cannot edit power levels (need higher power for{" "}
            <code style={{ fontSize: 11 }}>m.room.power_levels</code>).
          </span>
        )}
      </div>

      <SectionTitle palette={palette} typography={typography}>
        Moderation
      </SectionTitle>
      <LevelField
        id="pl-ban"
        label="Ban users"
        value={draft.ban}
        disabled={disabled}
        onChange={(n) => updateDraft({ ban: n })}
        palette={palette}
        typography={typography}
        spacing={spacing}
      />
      <LevelField
        id="pl-kick"
        label="Kick users"
        value={draft.kick}
        disabled={disabled}
        onChange={(n) => updateDraft({ kick: n })}
        palette={palette}
        typography={typography}
        spacing={spacing}
      />
      <LevelField
        id="pl-redact"
        label="Redact messages"
        description="Remove others’ messages (own messages may use a lower threshold on some servers)."
        value={draft.redact}
        disabled={disabled}
        onChange={(n) => updateDraft({ redact: n })}
        palette={palette}
        typography={typography}
        spacing={spacing}
      />
      <LevelField
        id="pl-invite"
        label="Invite users"
        value={draft.invite}
        disabled={disabled}
        onChange={(n) => updateDraft({ invite: n })}
        palette={palette}
        typography={typography}
        spacing={spacing}
      />

      <SectionTitle palette={palette} typography={typography}>
        Defaults
      </SectionTitle>
      <LevelField
        id="pl-users-def"
        label="Default power for new members"
        description="Power level assigned to users without a specific override."
        value={draft.usersDefault}
        disabled={disabled}
        onChange={(n) => updateDraft({ usersDefault: n })}
        palette={palette}
        typography={typography}
        spacing={spacing}
      />
      <LevelField
        id="pl-events-def"
        label="Default for messages & timeline events"
        description="Sending normal room messages (and other non-state events)."
        value={draft.eventsDefault}
        disabled={disabled}
        onChange={(n) => updateDraft({ eventsDefault: n })}
        palette={palette}
        typography={typography}
        spacing={spacing}
      />
      <LevelField
        id="pl-state-def"
        label="Default for state events"
        description="Used when a specific event type is not listed below."
        value={draft.stateDefault}
        disabled={disabled}
        onChange={(n) => updateDraft({ stateDefault: n })}
        palette={palette}
        typography={typography}
        spacing={spacing}
      />

      <SectionTitle palette={palette} typography={typography}>
        Notifications
      </SectionTitle>
      <LevelField
        id="pl-notify-room"
        label='Send @room notifications'
        description="Minimum power to trigger a room notification for all members."
        value={draft.notificationsRoom}
        disabled={disabled}
        onChange={(n) => updateDraft({ notificationsRoom: n })}
        palette={palette}
        typography={typography}
        spacing={spacing}
      />

      <SectionTitle palette={palette} typography={typography}>
        Room settings (state events)
      </SectionTitle>
      {ROOM_STATE_EVENT_KEYS.map(({ key, label }) => (
        <LevelField
          key={key}
          id={`pl-ev-${key}`}
          label={label}
          value={draft.eventLevels[key] ?? draft.stateDefault}
          disabled={disabled}
          onChange={(n) => updateEventLevel(key, n)}
          palette={palette}
          typography={typography}
          spacing={spacing}
        />
      ))}

      {isSpace && (
        <>
          <SectionTitle palette={palette} typography={typography}>
            Space
          </SectionTitle>
          {SPACE_STATE_EVENT_KEYS.map(({ key, label }) => (
            <LevelField
              key={key}
              id={`pl-sp-${key}`}
              label={label}
              value={draft.eventLevels[key] ?? draft.stateDefault}
              disabled={disabled}
              onChange={(n) => updateEventLevel(key, n)}
              palette={palette}
              typography={typography}
              spacing={spacing}
            />
          ))}
        </>
      )}

      {saveError && (
        <div
          style={{
            marginTop: spacing.unit * 3,
            padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
            borderRadius: 8,
            border: "1px solid rgba(237,66,69,0.35)",
            backgroundColor: "rgba(237,66,69,0.12)",
            color: "#ed4245",
            fontSize: typography.fontSizeSmall,
          }}
        >
          {saveError}
        </div>
      )}

      {canEdit && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: spacing.unit * 4,
            paddingTop: spacing.unit * 2,
            borderTop: `1px solid ${palette.border}`,
          }}
        >
          {success && (
            <span
              style={{
                marginRight: "auto",
                color: "#23a55a",
                fontSize: typography.fontSizeSmall,
              }}
            >
              Saved
            </span>
          )}
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty || saving}
            style={{
              padding: "8px 16px",
              fontSize: typography.fontSizeBase,
              fontFamily: typography.fontFamily,
              fontWeight: typography.fontWeightMedium,
              backgroundColor: "transparent",
              border: `1px solid ${palette.border}`,
              borderRadius: 4,
              color: palette.textPrimary,
              cursor: !dirty || saving ? "not-allowed" : "pointer",
              opacity: !dirty || saving ? 0.5 : 1,
            }}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            style={{
              padding: "8px 20px",
              fontSize: typography.fontSizeBase,
              fontFamily: typography.fontFamily,
              fontWeight: typography.fontWeightMedium,
              backgroundColor: !dirty || saving ? palette.accent + "80" : palette.accent,
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: !dirty || saving ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {saving ? (
              <>
                <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
