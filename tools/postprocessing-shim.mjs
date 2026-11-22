// 打包用的替身：npm n8ao 的 N8AOPostPass 继承的是 pmndrs「postprocessing」库的 Pass。我们用的是 three 自带的 EffectComposer，
// 不装那个库，打包时把 'postprocessing' 指到这里（tools/build-three.mjs 的 alias）。N8AOPostPass 只用到下面这些字段，
// 渲染由 world.js 里的适配 Pass（three 的 Pass）调它的 setDepthTexture / render(renderer, inputBuffer, outputBuffer)。
export class Pass {
  constructor(name = 'Pass', scene = null, camera = null) {
    this.name = name;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    this.needsSwap = true;
    this.needsDepthTexture = false;
    this.renderToScreen = false;
  }
  setSize() {}
  setDepthTexture() {}
  initialize() {}
  render() {}
  dispose() {}
}
