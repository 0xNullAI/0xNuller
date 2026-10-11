/** A small WebXR renderer for a private 2D portrait placed on a tracked surface. */
interface XrPose {
  transform: { matrix: Float32Array | number[]; position: { x: number; y: number; z: number } };
}
interface XrFrame {
  getHitTestResults(source: { cancel(): void }): Array<{ getPose(space: unknown): XrPose | null }>;
  getViewerPose(space: unknown): {
    transform: XrPose['transform'];
    views: Array<{
      projectionMatrix: Float32Array;
      transform: { inverse: { matrix: Float32Array } };
    }>;
  } | null;
}
interface XrSession {
  renderState: {
    baseLayer?: {
      framebuffer: WebGLFramebuffer;
      getViewport(view: unknown): { x: number; y: number; width: number; height: number };
    };
  };
  requestReferenceSpace(kind: 'viewer' | 'local'): Promise<unknown>;
  requestHitTestSource(options: { space: unknown }): Promise<{ cancel(): void }>;
  updateRenderState(options: { baseLayer: unknown }): void;
  requestAnimationFrame(callback: (time: number, frame: XrFrame) => void): void;
  addEventListener(kind: 'select' | 'end', listener: () => void): void;
  removeEventListener(kind: 'select' | 'end', listener: () => void): void;
  end(): Promise<void>;
}
interface XrSystem {
  isSessionSupported(mode: 'immersive-ar'): Promise<boolean>;
  requestSession(
    mode: 'immersive-ar',
    options: {
      requiredFeatures: string[];
      optionalFeatures: string[];
      domOverlay: { root: HTMLElement };
    },
  ): Promise<XrSession>;
}

function xrSystem(): XrSystem | null {
  if (!window.isSecureContext) return null;
  return (navigator as Navigator & { xr?: XrSystem }).xr ?? null;
}

export async function supportsCharacterAr(): Promise<boolean> {
  const xr = xrSystem();
  if (!xr) return false;
  try {
    return await xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

type Point = { x: number; y: number; z: number };

function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const result = new Float32Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        result[col * 4 + row] =
          (result[col * 4 + row] ?? 0) + (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
  return result;
}

function compile(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error('无法创建 AR 着色器');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('AR 着色器不可用');
  return shader;
}

async function loadPortrait(source: string | null): Promise<HTMLImageElement | HTMLCanvasElement> {
  if (source?.startsWith('blob:')) {
    const image = new Image();
    image.src = source;
    try {
      await image.decode();
      return image;
    } catch {
      // A revoked or invalid private image uses the local default symbol.
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法绘制角色形象');
  context.fillStyle = '#31215b';
  context.fillRect(0, 0, 256, 256);
  context.fillStyle = '#e9dcff';
  context.font = '180px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('✦', 128, 128);
  return canvas;
}

export interface CharacterArHandle {
  end(): Promise<void>;
}

/** Must be called from a click; requestSession is the only camera/spatial permission path. */
export async function startCharacterAr({
  source,
  overlay,
  onEnd,
  onPlacement,
  isCurrent = () => true,
}: {
  source: string | null;
  overlay: HTMLElement;
  onEnd(): void;
  onPlacement(): void;
  isCurrent?: () => boolean;
}): Promise<CharacterArHandle> {
  const xr = xrSystem();
  if (!xr) throw new Error('此浏览器不支持 WebXR AR');
  const session = await xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test', 'local'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: overlay },
  });
  let hitSource: { cancel(): void } | null = null;
  let gl: WebGLRenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let texture: WebGLTexture | null = null;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    hitSource?.cancel();
    if (gl) {
      if (texture) gl.deleteTexture(texture);
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
    }
    session.removeEventListener('select', select);
    session.removeEventListener('end', finish);
    onEnd();
  };
  let candidate: Point | null = null;
  let placed: Point | null = null;
  const select = () => {
    if (!candidate) return;
    placed = { ...candidate };
    onPlacement();
  };
  try {
    if (!isCurrent()) throw new Error('角色已切换');
    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl', {
      alpha: true,
      xrCompatible: true,
    }) as WebGLRenderingContext | null;
    if (!gl) throw new Error('此浏览器无法绘制 WebXR 画面');
    await (
      gl as WebGLRenderingContext & { makeXRCompatible?: () => Promise<void> }
    ).makeXRCompatible?.();
    if (!isCurrent()) throw new Error('角色已切换');
    const Layer = (
      window as Window & { XRWebGLLayer?: new (s: XrSession, g: WebGLRenderingContext) => unknown }
    ).XRWebGLLayer;
    if (!Layer) throw new Error('此浏览器缺少 WebXR 图层');
    session.updateRenderState({ baseLayer: new Layer(session, gl) });
    const localSpace = await session.requestReferenceSpace('local');
    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewerSpace });
    if (!isCurrent()) throw new Error('角色已切换');

    const vertex = compile(
      gl,
      gl.VERTEX_SHADER,
      'attribute vec3 aPosition; attribute vec2 aUv; uniform mat4 uMvp; varying vec2 vUv; void main(){ vUv=aUv; gl_Position=uMvp*vec4(aPosition,1.0); }',
    );
    const fragment = compile(
      gl,
      gl.FRAGMENT_SHADER,
      'precision mediump float; varying vec2 vUv; uniform sampler2D uTexture; uniform float uOpacity; void main(){ vec4 color=texture2D(uTexture,vUv); gl_FragColor=vec4(color.rgb,color.a*uOpacity); }',
    );
    program = gl.createProgram();
    if (!program) throw new Error('无法创建 AR 绘制程序');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('AR 绘制程序不可用');
    buffer = gl.createBuffer();
    texture = gl.createTexture();
    if (!buffer || !texture) throw new Error('无法创建 AR 画面');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -0.5, 0, 0, 0, 0, 0.5, 0, 0, 1, 0, -0.5, 1, 0, 0, 1, -0.5, 1, 0, 0, 1, 0.5, 0, 0, 1, 0, 0.5,
        1, 0, 1, 1,
      ]),
      gl.STATIC_DRAW,
    );
    const portrait = await loadPortrait(source);
    if (!isCurrent()) throw new Error('角色已切换');
    const width = portrait instanceof HTMLImageElement ? portrait.naturalWidth : portrait.width;
    const height = portrait instanceof HTMLImageElement ? portrait.naturalHeight : portrait.height;
    const cardWidth = Math.min(0.8, Math.max(0.3, (0.75 * width) / height));
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, portrait);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
    const position = gl.getAttribLocation(program, 'aPosition');
    const uv = gl.getAttribLocation(program, 'aUv');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
    const mvp = gl.getUniformLocation(program, 'uMvp');
    const opacity = gl.getUniformLocation(program, 'uOpacity');
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);
    const draw = (
      point: Point,
      viewer: Point,
      view: NonNullable<ReturnType<XrFrame['getViewerPose']>>['views'][number],
      alpha: number,
    ) => {
      if (!gl) return;
      const dx = viewer.x - point.x;
      const dz = viewer.z - point.z;
      const length = Math.hypot(dx, dz) || 1;
      const fx = dx / length;
      const fz = dz / length;
      const model = new Float32Array([
        fz * cardWidth,
        0,
        -fx * cardWidth,
        0,
        0,
        0.75,
        0,
        0,
        fx,
        0,
        fz,
        0,
        point.x,
        point.y,
        point.z,
        1,
      ]);
      gl.uniformMatrix4fv(
        mvp,
        false,
        multiply(view.projectionMatrix, multiply(view.transform.inverse.matrix, model)),
      );
      gl.uniform1f(opacity, alpha);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    session.addEventListener('select', select);
    session.addEventListener('end', finish);
    const render = (_time: number, frame: XrFrame) => {
      if (ended || !gl || !hitSource) return;
      const pose = frame.getViewerPose(localSpace);
      const hit = frame.getHitTestResults(hitSource)[0]?.getPose(localSpace);
      candidate = hit ? { ...hit.transform.position } : null;
      const layer = session.renderState.baseLayer;
      if (pose && layer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        for (const view of pose.views) {
          const viewport = layer.getViewport(view);
          gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          if (candidate) draw(candidate, pose.transform.position, view, placed ? 0.35 : 0.7);
          if (placed) draw(placed, pose.transform.position, view, 1);
        }
      }
      session.requestAnimationFrame(render);
    };
    session.requestAnimationFrame(render);
    return { end: () => session.end() };
  } catch (error) {
    finish();
    await session.end().catch(() => undefined);
    throw error;
  }
}
