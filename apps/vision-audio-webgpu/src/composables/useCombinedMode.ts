import { ref, watch } from 'vue'

interface CapturedImage {
  imageBuffer: Uint8ClampedArray
  imageWidth: number
  imageHeight: number
  channels: 1 | 2 | 3 | 4
}

export function useCombinedMode() {
  // Combined mode state
  const combinedMode = ref<boolean>(false)
  const callStarted = ref<boolean>(false)
  const callStartTime = ref<number | null>(null)
  const elapsedTime = ref<string>('00:00')
  const ripples = ref<number[]>([])
  const lastCapturedImage = ref<CapturedImage | null>(null)

  // External functions that will be injected
  const visionProcessFn = ref<((instruction: string, image: CapturedImage) => Promise<string | null>) | null>(null)
  const audioSynthesizeFn = ref<((text: string) => void) | null>(null)
  const audioSetupFn = ref<(() => Promise<void>) | null>(null)
  const audioStartFn = ref<(() => void) | null>(null)
  const audioEndFn = ref<(() => void) | null>(null)
  const visionLoadFn = ref<(() => Promise<void>) | null>(null)

  // Capture and process combined vision-audio interaction
  async function processVisionAudioCombined(instruction: string) {
    if (!lastCapturedImage.value || !visionProcessFn.value || !audioSynthesizeFn.value) {
      console.warn('Required functions or captured image not available')
      return
    }

    try {
      const response = await visionProcessFn.value(instruction, lastCapturedImage.value)

      if (response) {
        audioSynthesizeFn.value(response)
      }
    }
    catch (e) {
      console.error('Error in combined processing:', e)
    }
  }

  // Handle when audio listening starts
  function onAudioListeningStart(captureImageFn: () => CapturedImage | null) {
    if (combinedMode.value) {
      lastCapturedImage.value = captureImageFn()
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
      if (visionLoadFn.value) {
        await visionLoadFn.value()
      }

      // Setup audio call
      if (audioSetupFn.value) {
        await audioSetupFn.value()
      }

      // Start combined mode
      combinedMode.value = true
      callStartTime.value = Date.now()
      callStarted.value = true

      if (audioStartFn.value) {
        audioStartFn.value()
      }

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

    if (audioEndFn.value) {
      audioEndFn.value()
    }

    stopRippleAnimation()
  }

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

  return {
    // State
    combinedMode,
    callStarted,
    elapsedTime,
    ripples,
    lastCapturedImage,

    // Function injectors
    visionProcessFn,
    audioSynthesizeFn,
    audioSetupFn,
    audioStartFn,
    audioEndFn,
    visionLoadFn,

    // Methods
    startCombinedSession,
    stopCombinedSession,
    onAudioListeningStart,
    onAudioListeningEnd,
  }
}
