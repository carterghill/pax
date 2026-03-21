import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Monitor, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { registerOverlay, unregisterOverlay } from "../hooks/useOverlayObstruction";

/**
 * ScreenShareViewer — dual-path video renderer.
 *
 * Native GPU path (Windows):
 *   Rust renders decoded I420 frames directly to a native HWND overlay
 *   using wgpu.  This component just reports its bounding rect so Rust
 *   can position the overlay to match.  Zero IPC for frame data.
 *
 * WebGL fallback (Linux, or if native init fails):
 *   Fetches packed I420 frames via paxvideo:// protocol and renders
 *   with a YUV→RGB WebGL shader.  Same as before.
 */

interface ScreenShareViewerProps {
  active: boolean;
  identity: string;
}

const URL_PREFIX = navigator.userAgent.includes("Windows")
  ? "http://paxvideo.localhost"
  : "paxvideo://localhost";

/** Match `backgroundColor: palette.bgPrimary` for the native GPU letterbox clear (DX12 is opaque-only). */
function bgPrimaryToRgb01(hex: string): { r: number; g: number; b: number } {
  const fallback = { r: 49 / 255, g: 51 / 255, b: 56 / 255 };
  const h = hex.trim().replace(/^#/, "");
  const x = (s: string) => parseInt(s, 16) / 255;
  let out: { r: number; g: number; b: number };
  if (h.length === 3) {
    out = { r: x(h[0] + h[0]), g: x(h[1] + h[1]), b: x(h[2] + h[2]) };
  } else if (h.length === 6) {
    out = { r: x(h.slice(0, 2)), g: x(h.slice(2, 4)), b: x(h.slice(4, 6)) };
  } else {
    return fallback;
  }
  return Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b) ? out : fallback;
}

// ─── Native overlay support detection (cached) ─────────────────────────────

let _nativeSupported: boolean | null = null;
async function isNativeOverlaySupported(): Promise<boolean> {
  if (_nativeSupported !== null) return _nativeSupported;
  try {
    _nativeSupported = await invoke<boolean>("overlay_is_supported");
  } catch {
    _nativeSupported = false;
  }
  return _nativeSupported;
}

// ─── WebGL YUV Renderer (fallback) ─────────────────────────────────────────

const VERTEX_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    v_uv.y = 1.0 - v_uv.y;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

const FRAGMENT_SRC = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_y;
  uniform sampler2D u_u;
  uniform sampler2D u_v;
  void main() {
    float y = texture2D(u_y, v_uv).r;
    float u = texture2D(u_u, v_uv).r - 0.5;
    float v = texture2D(u_v, v_uv).r - 0.5;
    float r = y + 1.402 * v;
    float g = y - 0.344 * u - 0.714 * v;
    float b = y + 1.772 * u;
    gl_FragColor = vec4(r, g, b, 1.0);
  }
`;

interface GlState {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texY: WebGLTexture;
  texU: WebGLTexture;
  texV: WebGLTexture;
  currentW: number;
  currentH: number;
}

function initGl(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl", {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, VERTEX_SRC);
  gl.compileShader(vs);

  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, FRAGMENT_SRC);
  gl.compileShader(fs);

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.uniform1i(gl.getUniformLocation(program, "u_y"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "u_u"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "u_v"), 2);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const texY = createLuminanceTexture(gl);
  const texU = createLuminanceTexture(gl);
  const texV = createLuminanceTexture(gl);

  return { gl, program, texY, texU, texV, currentW: 0, currentH: 0 };
}

function createLuminanceTexture(gl: WebGLRenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function uploadAndDraw(state: GlState, buf: ArrayBuffer, width: number, height: number) {
  const { gl, texY, texU, texV } = state;

  const ySize = width * height;
  const cw = width >> 1;
  const ch = height >> 1;
  const uvSize = cw * ch;

  const yData = new Uint8Array(buf, 8, ySize);
  const uData = new Uint8Array(buf, 8 + ySize, uvSize);
  const vData = new Uint8Array(buf, 8 + ySize + uvSize, uvSize);

  const dimsChanged = state.currentW !== width || state.currentH !== height;
  if (dimsChanged) {
    gl.canvas.width = width;
    gl.canvas.height = height;
    gl.viewport(0, 0, width, height);
    state.currentW = width;
    state.currentH = height;
  }

  if (dimsChanged) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texY);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, yData);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texU);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, cw, ch, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, uData);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texV);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, cw, ch, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, vData);
  } else {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texY);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.LUMINANCE, gl.UNSIGNED_BYTE, yData);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texU);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cw, ch, gl.LUMINANCE, gl.UNSIGNED_BYTE, uData);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texV);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cw, ch, gl.LUMINANCE, gl.UNSIGNED_BYTE, vData);
  }

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ScreenShareViewer({ active, identity }: ScreenShareViewerProps) {
  const { palette, spacing, typography } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glStateRef = useRef<GlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [useNative, setUseNative] = useState<boolean | null>(null); // null = detecting
  const loadingRef = useRef(true);

  // ── Detect native overlay support ────────────────────────────────
  useEffect(() => {
    isNativeOverlaySupported().then((supported) => {
      console.log("[ScreenShareViewer] Native overlay supported:", supported);
      setUseNative(supported);
    });
  }, []);

  // ── Native overlay: report rect to Rust ──────────────────────────
  useEffect(() => {
    console.log("[ScreenShareViewer] Native effect check:", { active, identity, useNative, hasContainer: !!containerRef.current });
    if (!active || !identity || useNative !== true || !containerRef.current) return;

    // Register this overlay for obstruction tracking
    registerOverlay(identity, containerRef.current);

    let mounted = true;
    let firstRect = true;

    const reportRect = () => {
      const el = containerRef.current;
      if (!el || !mounted) return;
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(rect.left * dpr);
      const y = Math.round(rect.top * dpr);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (w > 0 && h > 0) {
        console.log("[ScreenShareViewer] Reporting rect:", { identity, x, y, w, h });
        invoke("overlay_set_rect", { identity, x, y, w, h })
          .catch((e) => console.error("[ScreenShareViewer] overlay_set_rect failed:", e));
        const { r, g, b } = bgPrimaryToRgb01(palette.bgPrimary);
        invoke("overlay_set_letterbox_color", { identity, r, g, b }).catch((e) =>
          console.error("[ScreenShareViewer] overlay_set_letterbox_color failed:", e),
        );
        if (firstRect) {
          invoke("overlay_set_visible", { identity, visible: true })
            .catch((e) => console.error("[ScreenShareViewer] overlay_set_visible failed:", e));
          firstRect = false;
          setLoading(false);
          loadingRef.current = false;
        }
      }
    };

    // Report initial rect
    reportRect();

    // Track container resize
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(reportRect, 16); // ~1 frame debounce
    });
    observer.observe(containerRef.current);

    // Track scroll/layout shifts with rAF for smooth positioning
    let rafId = 0;
    let lastX = -1, lastY = -1, lastW = -1, lastH = -1;
    const trackPosition = () => {
      if (!mounted) return;
      rafId = requestAnimationFrame(trackPosition);
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(rect.left * dpr);
      const y = Math.round(rect.top * dpr);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (x !== lastX || y !== lastY || w !== lastW || h !== lastH) {
        lastX = x; lastY = y; lastW = w; lastH = h;
        invoke("overlay_set_rect", { identity, x, y, w, h })
          .catch((e) => console.error("[ScreenShareViewer] rAF set_rect failed:", e));
        const { r, g, b } = bgPrimaryToRgb01(palette.bgPrimary);
        invoke("overlay_set_letterbox_color", { identity, r, g, b }).catch(() => {});
      }
    };
    rafId = requestAnimationFrame(trackPosition);

    return () => {
      mounted = false;
      observer.disconnect();
      cancelAnimationFrame(rafId);
      if (resizeTimer) clearTimeout(resizeTimer);
      unregisterOverlay(identity);
      invoke("overlay_set_visible", { identity, visible: false }).catch(() => {});
    };
  }, [active, identity, useNative, palette.bgPrimary]);

  // ── WebGL fallback: steady presentation clock ────────────────────
  useEffect(() => {
    if (!active || !identity || useNative !== false) return;

    let mounted = true;
    let frameAvailable = true;
    let fetchInFlight = false;
    let rafId = 0;
    let unlisten: UnlistenFn | null = null;
    const encodedId = encodeURIComponent(identity);

    // Debounced resize reporting for protocol path
    const reportSize = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (w > 0 && h > 0) {
        fetch(`${URL_PREFIX}/resize?id=${encodedId}&w=${w}&h=${h}`).catch(() => {});
      }
    };
    reportSize();
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObs = containerRef.current
      ? new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(reportSize, 150);
        })
      : null;
    if (resizeObs && containerRef.current) resizeObs.observe(containerRef.current);

    const tick = () => {
      if (!mounted) return;
      rafId = requestAnimationFrame(tick);
      if (!frameAvailable || fetchInFlight) return;
      frameAvailable = false;
      fetchInFlight = true;

      (async () => {
        try {
          const resp = await fetch(`${URL_PREFIX}/frame?id=${encodedId}`);
          if (!mounted) return;
          if (resp.status === 204 || !resp.ok) return;

          const buf = await resp.arrayBuffer();
          if (!mounted) return;
          if (buf.byteLength < 8) return;

          const header = new DataView(buf, 0, 8);
          const width = header.getUint32(0, true);
          const height = header.getUint32(4, true);

          const ySize = width * height;
          const uvSize = (width >> 1) * (height >> 1);
          const expectedSize = 8 + ySize + uvSize * 2;
          if (buf.byteLength < expectedSize || width === 0 || height === 0) return;

          if (!glStateRef.current) {
            const canvas = canvasRef.current;
            if (canvas) glStateRef.current = initGl(canvas);
          }

          const glState = glStateRef.current;
          if (!glState) return;

          uploadAndDraw(glState, buf, width, height);

          if (loadingRef.current) {
            loadingRef.current = false;
            setLoading(false);
          }
        } catch {
          // Expected during start/stop transitions
        } finally {
          fetchInFlight = false;
        }
      })();
    };

    rafId = requestAnimationFrame(tick);

    listen<{ id: string }>("screen-share-frame-ready", (event) => {
      if (event.payload.id === identity) {
        frameAvailable = true;
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      mounted = false;
      cancelAnimationFrame(rafId);
      if (unlisten) unlisten();
      if (resizeObs) resizeObs.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      glStateRef.current = null;
      loadingRef.current = true;
      fetch(`${URL_PREFIX}/resize?id=${encodeURIComponent(identity)}&w=0&h=0`).catch(() => {});
    };
  }, [active, identity, useNative]);

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: palette.bgPrimary,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Loading spinner */}
      {loading && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: spacing.unit * 2,
            color: palette.textSecondary,
          }}
        >
          <style>{`@keyframes ssv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          <Loader2
            size={32}
            color={palette.textSecondary}
            style={{ animation: "ssv-spin 1s linear infinite" }}
          />
          <span style={{ fontSize: typography.fontSizeSmall }}>
            {useNative === null
              ? "Initializing..."
              : useNative
                ? "Waiting for native video..."
                : "Waiting for screen share frames..."}
          </span>
        </div>
      )}

      {/* Native path: layout anchor div — HWND renders on top */}
      {useNative === true && !loading && (
        <div style={{ width: "100%", height: "100%" }} />
      )}

      {/* WebGL fallback path: canvas */}
      {useNative === false && (
        <canvas
          ref={canvasRef}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            display: loading ? "none" : "block",
          }}
        />
      )}

      {/* Resolution/mode badge */}
      {!loading && (
        <div
          style={{
            position: "absolute",
            bottom: spacing.unit,
            right: spacing.unit * 2,
            fontSize: typography.fontSizeSmall - 1,
            color: palette.textSecondary,
            opacity: 0.6,
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            // Ensure badge renders above the native overlay
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          <Monitor size={10} />
          {useNative ? "Native GPU" : "WebGL"}
        </div>
      )}
    </div>
  );
}