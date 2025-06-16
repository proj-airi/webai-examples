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
      title: 'Realtime Conversational WebGPU (Vue)',
      emoji: '💬',
      colorFrom: 'blue',
      colorTo: 'green',
      sdk: 'static',
      pinned: false,
      license: 'mit',
      models: [''],
      short_description: 'Yet another Realtime Conversational WebGPU',
    }),
  ],
  worker: { format: 'es' },
})
