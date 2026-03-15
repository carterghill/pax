import { useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Monitor, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

/**
 * ScreenShareViewer — GPU-accelerated YUV video renderer.
 *
 * Pipeline:
 *   Rust: LiveKit → I420 scale (libyuv) → pack Y/U/V planes → emit event
 *   Frontend: event → fetch I420 (~3MB) → upload 3 GL textures → YUV→RGB shader
 *
 * This matches how browser <video> elements work internally.
 * At 1080p: 3.1MB transfer + GPU shader vs old 8.3MB + CPU putImageData.
 */

interface ScreenShareViewerProps {
  active: boolean;
  identity: string;
}

const URL_PREFIX = navigator.userAgent.includes("Windows")
  ? "http://paxvideo.localhost"
  : "paxvideo://localhost";

// ─── WebGL YUV Renderer ─────────────────────────────────────────────────────

const VERTEX_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    v_uv.y = 1.0 - v_uv.y; // flip Y for top-down image data
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

// BT.601 limited range YUV→RGB conversion (standard for WebRTC video)
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
    // BT.601
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

  // Compile shaders
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

  // Fullscreen quad (two triangles)
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Bind texture units to uniforms
  gl.uniform1i(gl.getUniformLocation(program, "u_y"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "u_u"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "u_v"), 2);

  // LUMINANCE textures have 1-byte-per-pixel rows — must disable
  // the default 4-byte row alignment or uploads read garbage.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  // Create textures
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

  // Use texSubImage2D when dimensions are stable (just updates pixel data,
  // no GPU-side texture reallocation). Fall back to texImage2D on size change.
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const glStateRef = useRef<GlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  // ── Debounced resize reporting ──────────────────────────────────────
  useEffect(() => {
    if (!active || !containerRef.current) return;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const encodedId = encodeURIComponent(identity);

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

    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(reportSize, 150);
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, [active, identity]);

  // ── Event-driven frame delivery ────────────────────────────────────
  useEffect(() => {
    if (!active || !identity) {
      setLoading(true);
      setDimensions(null);
      glStateRef.current = null;
      return;
    }

    let mounted = true;
    let busy = false;
    let unlisten: UnlistenFn | null = null;
    const encodedId = encodeURIComponent(identity);

    const fetchAndDraw = async () => {
      if (busy || !mounted) return;
      busy = true;

      try {
        const resp = await fetch(`${URL_PREFIX}/frame?id=${encodedId}`);
        if (!mounted) { busy = false; return; }
        if (resp.status === 204 || !resp.ok) { busy = false; return; }

        const buf = await resp.arrayBuffer();
        if (!mounted) { busy = false; return; }
        if (buf.byteLength < 8) { busy = false; return; }

        const header = new DataView(buf, 0, 8);
        const width = header.getUint32(0, true);
        const height = header.getUint32(4, true);

        const ySize = width * height;
        const uvSize = (width >> 1) * (height >> 1);
        const expectedSize = 8 + ySize + uvSize * 2;
        if (buf.byteLength < expectedSize || width === 0 || height === 0) {
          busy = false;
          return;
        }

        // Initialize WebGL on first frame
        if (!glStateRef.current) {
          const canvas = canvasRef.current;
          if (canvas) {
            glStateRef.current = initGl(canvas);
          }
        }

        const glState = glStateRef.current;
        if (!glState) { busy = false; return; }

        // Upload textures and draw — GPU-accelerated, sub-millisecond
        uploadAndDraw(glState, buf, width, height);

        setLoading(false);
        setDimensions((prev) =>
          prev?.width === width && prev?.height === height
            ? prev
            : { width, height }
        );

        busy = false;
      } catch {
        busy = false;
      }
    };

    listen<{ id: string }>("screen-share-frame-ready", (event) => {
      if (event.payload.id === identity) {
        fetchAndDraw();
      }
    }).then((fn) => {
      unlisten = fn;
    });

    fetchAndDraw();

    return () => {
      mounted = false;
      if (unlisten) unlisten();
      glStateRef.current = null;
      fetch(`${URL_PREFIX}/resize?id=${encodeURIComponent(identity)}&w=0&h=0`).catch(() => {});
    };
  }, [active, identity]);

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
            Waiting for screen share frames...
          </span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          display: loading ? "none" : "block",
        }}
      />
      {dimensions && !loading && (
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
          }}
        >
          <Monitor size={10} />
          {dimensions.width}×{dimensions.height}
        </div>
      )}
    </div>
  );
}