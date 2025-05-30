import { MotionPlugin } from '@vueuse/motion'
import { createApp } from 'vue'

import App from './App.vue'

import '@unocss/reset/tailwind.css'
import './styles/main.css'
import 'uno.css'

createApp(App)
  .use(MotionPlugin)
  .mount('#app')
