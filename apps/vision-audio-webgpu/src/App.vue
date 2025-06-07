<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, provide, ref, watch } from 'vue'

import AudioPanel from './components/AudioPanel.vue'
import VideoPanel from './components/VideoPanel.vue'
import { useAudioStore } from './composables/use-audio'
import { useVisionStore } from './composables/use-vision'

// Interface for captured image
interface CapturedImage {
  imageBuffer: Uint8ClampedArray
  imageWidth: number
  imageHeight: number
  channels: 1 | 2 | 3 | 4
}

// Initialize composables
const audio = useAudioStore()
const vision = useVisionStore()
const { instructionText, videoScreen, captureCanvas } = storeToRefs(vision)
const { onListeningStart, onListeningEnd } = storeToRefs(audio)

// Combined mode state (moved from useCombinedMode)
const combinedMode = ref<boolean>(false)
const callStarted = ref<boolean>(false)
const callStartTime = ref<number | null>(null)
const elapsedTime = ref<string>('00:00')
const ripples = ref<number[]>([])
const lastCapturedImage = ref<CapturedImage | null>(null)

// Ripple animation management
let rippleInterval: NodeJS.Timeout | null = null

function startRippleAnimation() {
  if (rippleInterval)
    return

  rippleInterval = setInterval(() => {
    const id = Date.now()
    ripples.value = [...ripples.value, id]
    setTimeout(() => {
      ripples.value = ripples.value.filter(r => r !== id)
    }, 1500)
  }, 1000)
}

function stopRippleAnimation() {
  if (rippleInterval) {
    clearInterval(rippleInterval)
    rippleInterval = null
  }
  ripples.value = []
}

// Capture and process combined vision-audio interaction
async function processVisionAudioCombined(instruction: string) {
  if (!lastCapturedImage.value) {
    console.warn('No captured image available')
    return
  }

  try {
    const originalInstruction = instructionText.value
    instructionText.value = instruction

    const response = await vision.processImage(instruction)

    instructionText.value = originalInstruction

    if (response) {
      audio.synthesizeText(response)
    }
  }
  catch (e) {
    console.error('Error in combined processing:', e)
  }
}

// Handle when audio listening starts
function onAudioListeningStart() {
  if (combinedMode.value) {
    lastCapturedImage.value = vision.captureImage()
  }
}

// Handle when audio listening ends
function onAudioListeningEnd(instruction: string) {
  if (combinedMode.value && lastCapturedImage.value) {
    processVisionAudioCombined(instruction)
  }
}

// Start combined session
async function startCombinedSession() {
  try {
    // Load vision model if needed
    await vision.loadVisionModel()

    // Setup audio call
    await audio.setupAudioCall()

    // Start combined mode
    combinedMode.value = true
    callStartTime.value = Date.now()
    callStarted.value = true

    audio.startCall()

    // Start ripple animation
    startRippleAnimation()
  }
  catch (error) {
    console.error('Failed to start combined session:', error)
    stopCombinedSession()
  }
}

// Stop combined session
function stopCombinedSession() {
  combinedMode.value = false
  callStarted.value = false
  callStartTime.value = null
  lastCapturedImage.value = null

  audio.endCall()
  stopRippleAnimation()
}

// Setup combined mode integration
function setupCombinedModeIntegration() {
  // Connect audio callbacks to combined mode
  onListeningStart.value = onAudioListeningStart

  onListeningEnd.value = () => {
    onAudioListeningEnd(instructionText.value)
  }
}

// Watch for call timer
watch(callStarted, () => {
  let timerInterval: NodeJS.Timeout | null = null

  if (callStarted.value && callStartTime.value) {
    timerInterval = setInterval(() => {
      if (!callStartTime.value)
        return

      const diff = Math.floor((Date.now() - callStartTime.value) / 1000)
      const minutes = String(Math.floor(diff / 60)).padStart(2, '0')
      const seconds = String(diff % 60).padStart(2, '0')
      elapsedTime.value = `${minutes}:${seconds}`
    }, 1000)
  }
  else {
    elapsedTime.value = '00:00'
  }

  // Cleanup timer when call ends
  return () => {
    if (timerInterval) {
      clearInterval(timerInterval)
    }
  }
})

// Provide combined mode state and functions to child components
provide('combined', {
  // State
  combinedMode,
  callStarted,
  elapsedTime,
  ripples,
  lastCapturedImage,

  // Methods
  startCombinedSession,
  stopCombinedSession,
})

// Lifecycle
onMounted(() => {
  audio.setupAudioWorker()
  vision.initializeVisionWorker()
  vision.checkWebGPU()
  vision.videoScreenContainerBounding.update()
  setupCombinedModeIntegration()
})

onUnmounted(() => {
  audio.cleanup()
  vision.cleanup()

  // Cleanup combined mode resources
  if (rippleInterval) {
    clearInterval(rippleInterval)
  }
})
</script>

<template>
  <div class="relative h-screen min-h-[480px] flex bg-gray-50">
    <!-- Video Section (Left) -->
    <VideoPanel>
      <template #video-element>
        <video
          :ref="(el) => videoScreen = el as HTMLVideoElement"
          autoplay
          muted
          class="relative z-0 h-full w-full object-cover"
        />
        <canvas :ref="(el) => captureCanvas = el as HTMLCanvasElement" class="hidden" />
      </template>
    </VideoPanel>

    <!-- Audio Section (Right) -->
    <AudioPanel />

    <!-- Footer -->
    <div class="absolute bottom-4 left-1/2 transform text-sm text-gray-600 -translate-x-1/2">
      Built with
      <a
        href="https://github.com/huggingface/transformers.js"
        rel="noopener noreferrer"
        target="_blank"
        class="text-blue-600 hover:underline"
      >
        🤗 Transformers.js
      </a>
    </div>
  </div>
</template>

<style scoped>
@keyframes ripple {
  from {
    transform: scale(1);
    opacity: 0.7;
  }
  to {
    transform: scale(2);
    opacity: 0;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease-in-out;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0.5;
}

.fade-enter-to,
.fade-leave-from {
  opacity: 1;
}
</style>
