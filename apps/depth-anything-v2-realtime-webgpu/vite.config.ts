import Vue from '@vitejs/plugin-vue'
import { LFS, SpaceCard } from 'hfup/vite'
import Unocss from 'unocss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    Vue(),
    // https://github.com/antfu/unocss
    // see uno.config.ts for config
    Unocss(),

    // HuggingFace Spaces
    LFS(),
    SpaceCard({
      title: 'Realtime Video Depth Anything V2 WebGPU (Vue)',
      emoji: '👀',
      colorFrom: 'blue',
      colorTo: 'green',
      sdk: 'static',
      pinned: false,
      license: 'mit',
      models: ['onnx-community/depth-anything-v2-small'],
      short_description: 'Yet another WebGPU based Depth Anything V2, in Vue',
    }),
  ],
  worker: { format: 'es' },
})
