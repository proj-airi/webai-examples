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
      title: 'Realtime YOLOv9 Object Detection WebGPU (Vue)',
      emoji: '👀',
      colorFrom: 'blue',
      colorTo: 'green',
      sdk: 'static',
      pinned: false,
      license: 'mit',
      models: ['Xenova/yolos-tiny', 'Xenova/gelan-c_all'],
      short_description: 'Yet another Realtime YOLOv9 Object Detection WebGPU',
    }),
  ],
  worker: { format: 'es' },
})
