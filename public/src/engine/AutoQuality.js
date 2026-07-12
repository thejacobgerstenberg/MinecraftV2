// Voxelheim adaptive render quality — keeps the frame rate playable on weak
// GPUs and software rasterizers (SwiftShader/llvmpipe/etc) by scaling the
// renderer's internal resolution (drawing buffer) while the canvas stays
// fullscreen via CSS. On detected software rasterizers it also recommends
// "fast lighting" (see ChunkRenderer.setFastLighting): unlit chunk materials
// with the mesher's baked AO/face shading plus a scalar day/night tint,
// which avoids three.js per-fragment lighting entirely.
//
// API:
//   detectSoftwareRenderer(renderer) -> bool
//   new AutoQuality(renderer, opts?)
//     .software     bool  — software rasterizer detected on this context
//     .fastLighting bool  — chunk materials should use the unlit fast path
//     .scale        number— current internal resolution scale (pixel ratio)
//     .update(rawDt)      — call once per frame with REAL frame seconds
//     .reset()            — back to the initial scale (new game session)
//
// Control law: frame times are averaged over ~0.75 s windows. A slow window
// (fps < targetLow) steps the scale down 20%; two consecutive fast windows
// (fps > targetHigh) step it up 25%. Asymmetric thresholds prevent
// oscillation (a 1.25x pixel step from targetHigh cannot drop below
// targetLow). The window restarts after every scale change so the next
// decision only sees frames rendered at the new resolution.

const SOFTWARE_GL_RE = /swiftshader|llvmpipe|softpipe|soft pipe|subzero|software\s*(rasterizer|renderer|adapter)|microsoft basic render/i;

/** True when the renderer's WebGL context reports a software rasterizer. */
export function detectSoftwareRenderer(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const unmasked = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    const basic = gl.getParameter(gl.RENDERER) || '';
    return SOFTWARE_GL_RE.test(String(unmasked)) || SOFTWARE_GL_RE.test(String(basic));
  } catch {
    return false;
  }
}

export class AutoQuality {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{targetLow?:number, targetHigh?:number, minScale?:number,
   *          maxScale?:number, windowS?:number, initialScale?:number,
   *          software?:boolean}} [opts]
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.software = opts.software ?? detectSoftwareRenderer(renderer);
    this.fastLighting = this.software;

    this.targetLow = opts.targetLow ?? 24; // below this: scale down
    this.targetHigh = opts.targetHigh ?? 48; // above this (x2 windows): scale up
    this.maxScale = opts.maxScale ?? 1;
    // Software rasterizers are fill-bound: allow a much lower floor there.
    // The controller only sits at the floor while fps stays below targetLow.
    this.minScale = opts.minScale ?? (this.software ? 0.1 : 0.5);
    this.windowS = opts.windowS ?? 0.75;
    this._initialScale = Math.min(
      this.maxScale,
      Math.max(this.minScale, opts.initialScale ?? (this.software ? 0.4 : 1)),
    );

    this.scale = this._initialScale;
    this._winTime = 0;
    this._winFrames = 0;
    this._fastWindows = 0;
    this._apply();
  }

  /** Restore the initial scale (call when a fresh game session starts). */
  reset() {
    this._winTime = 0;
    this._winFrames = 0;
    this._fastWindows = 0;
    if (this.scale !== this._initialScale) {
      this.scale = this._initialScale;
      this._apply();
    }
  }

  /**
   * Feed one frame of REAL elapsed time (seconds, unclamped).
   * May adjust the renderer's pixel ratio.
   */
  update(rawDt) {
    if (!(rawDt >= 0)) return;
    if (rawDt > 1) {
      // Tab was hidden / massive stall — don't let it poison the window.
      this._winTime = 0;
      this._winFrames = 0;
      return;
    }
    this._winTime += rawDt;
    this._winFrames++;
    if (this._winTime < this.windowS) return;

    const fps = this._winFrames / this._winTime;
    this._winTime = 0;
    this._winFrames = 0;

    if (fps < this.targetLow && this.scale > this.minScale) {
      this._fastWindows = 0;
      this.scale = Math.max(this.minScale, this.scale * 0.8);
      this._apply();
    } else if (fps > this.targetHigh && this.scale < this.maxScale) {
      this._fastWindows++;
      if (this._fastWindows >= 2) {
        this._fastWindows = 0;
        this.scale = Math.min(this.maxScale, this.scale * 1.25);
        this._apply();
      }
    } else {
      this._fastWindows = 0;
    }
  }

  _apply() {
    // setPixelRatio re-runs setSize(width, height, false) internally, so the
    // drawing buffer resizes now while the canvas CSS size stays fullscreen.
    this.renderer.setPixelRatio(this.scale);
  }
}
