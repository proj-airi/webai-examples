<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

import AudioPanel from './components/AudioPanel.vue'
import VideoPanel from './components/VideoPanel.vue'
import { useAudio } from './composables/useAudio'
import { useCombinedMode } from './composables/useCombinedMode'
import { useVision } from './composables/useVision'

// Initialize composables
const audio = useAudio()
const vision = useVision()
const combined = useCombinedMode()

// Setup combined mode integration
function setupCombinedModeIntegration() {
  // Connect audio callbacks to combined mode
  audio.onListeningStart.value = () => {
    combined.onAudioListeningStart(vision.captureImage)
  }

  audio.onListeningEnd.value = () => {
    combined.onAudioListeningEnd(vision.instructionText.value)
  }

  // Connect combined mode callbacks to individual systems
  combined.visionProcessFn.value = async (instruction: string, _image: any) => {
    const originalInstruction = vision.instructionText.value
    vision.instructionText.value = instruction

    const result = await vision.processImage(instruction)

    vision.instructionText.value = originalInstruction
    return result || null
  }

  combined.audioSynthesizeFn.value = audio.synthesizeText
  combined.audioSetupFn.value = audio.setupAudioCall
  combined.audioStartFn.value = audio.startCall
  combined.audioEndFn.value = audio.endCall
  combined.visionLoadFn.value = vision.loadVisionModel
}

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
})
</script>

<template>
  <div class="relative h-screen min-h-[480px] flex bg-gray-50">
    <!-- Video Section (Left) -->
    <VideoPanel>
      <template #video-element>
        <video
          :ref="(el) => vision.videoScreen.value = el as HTMLVideoElement"
          autoplay
          muted
          class="relative z-0 h-full w-full object-cover"
        />
        <canvas :ref="(el) => vision.captureCanvas.value = el as HTMLCanvasElement" class="hidden" />
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
