import type {
  AutomaticSpeechRecognitionPipeline,
  CausalLMOutputWithPast,
  GPT2Tokenizer,
  LlamaForCausalLM,
  PreTrainedModel,
  StoppingCriteriaList,
} from '@huggingface/transformers'
import type { Device, DType } from '@xsai-transformers/shared/types'
import type { GenerateOptions } from 'kokoro-js'

import {
  // VAD
  AutoModel,

  AutoModelForCausalLM,
  // LLM
  AutoTokenizer,
  InterruptableStoppingCriteria,
  pipeline,

  // Speech recognition
  Tensor,
  TextStreamer,
} from '@huggingface/transformers'
import { isWebGPUSupported } from 'gpuu/webgpu'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'

import type {
  WorkerMessageEventError,
  WorkerMessageEventInfo,
  WorkerMessageEventOutput,
  WorkerMessageEventProgress,
  WorkerMessageEventSetVoiceResponse,
  WorkerMessageEventStatus,
} from '../types/worker'

import {
  EXIT_THRESHOLD,
  INPUT_SAMPLE_RATE,
  MAX_BUFFER_DURATION,
  MAX_NUM_PREV_BUFFERS,
  MIN_SILENCE_DURATION_SAMPLES,
  MIN_SPEECH_DURATION_SAMPLES,
  SPEECH_PAD_SAMPLES,
  SPEECH_THRESHOLD,
} from '../constants'

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type Voices = GenerateOptions['voice']
export type PretrainedConfig = NonNullable<Parameters<typeof AutoModel.from_pretrained>[1]>['config']

const whisperDtypeMap: Record<Device, DType> = {
  webgpu: {
    encoder_model: 'fp32',
    decoder_model_merged: 'fp32',
  },
  wasm: {
    encoder_model: 'fp32',
    decoder_model_merged: 'q8',
  },
}

const model_id = 'onnx-community/Kokoro-82M-v1.0-ONNX'
let voice: Voices | undefined
let silero_vad: PreTrainedModel
let transcriber: AutomaticSpeechRecognitionPipeline
let tts: KokoroTTS

const SYSTEM_MESSAGE: Message = {
  role: 'system',
  content:
    'You\'re a helpful and conversational voice assistant, respond to the user. Keep your responses short, clear, and casual.',
}
let messages: Message[] = [SYSTEM_MESSAGE]
let past_key_values_cache: any = null
let stopping_criteria: InterruptableStoppingCriteria | null = null

// Global audio buffer to store incoming audio
const BUFFER = new Float32Array(MAX_BUFFER_DURATION * INPUT_SAMPLE_RATE)
let bufferPointer = 0

// Initial state for VAD
const sr = new Tensor('int64', [INPUT_SAMPLE_RATE], [])
let state = new Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128])

// Whether we are in the process of adding audio to the buffer
let isRecording = false
let isPlaying = false // new flag

let tokenizer: GPT2Tokenizer
let llm: LlamaForCausalLM

const prevBuffers: Float32Array[] = []

export async function loadModels() {
  tts = await KokoroTTS.from_pretrained(model_id, {
    dtype: 'fp32',
    device: 'webgpu',
  })

  const device = 'webgpu'
  globalThis.postMessage({ type: 'info', data: { message: `Using device: "${device}"` } } satisfies WorkerMessageEventInfo)
  globalThis.postMessage({ type: 'info', data: { message: 'Loading models...', duration: 'until_next' } } satisfies WorkerMessageEventInfo)

  // Load models
  silero_vad = await AutoModel.from_pretrained(
    'onnx-community/silero-vad',
    {
      config: { model_type: 'custom' } as PretrainedConfig,
      dtype: 'fp32', // Full-precision
      progress_callback: progress => globalThis.postMessage({ type: 'progress', data: { message: progress } } satisfies WorkerMessageEventProgress),
    },
  ).catch((error: Error) => {
    globalThis.postMessage({ type: 'error', data: { error, message: error.message } } satisfies WorkerMessageEventError<Error>)
    throw error
  })

  transcriber = await pipeline(
    'automatic-speech-recognition',
    'onnx-community/whisper-medium', // or "onnx-community/moonshine-base-ONNX",
    {
      device,
      dtype: whisperDtypeMap[device as keyof typeof whisperDtypeMap],
      progress_callback: progress => globalThis.postMessage({ type: 'progress', data: { message: progress } } satisfies WorkerMessageEventProgress),
    },
  ).catch((error: Error) => {
    globalThis.postMessage({ type: 'error', data: { error, message: error.message } } satisfies WorkerMessageEventError<Error>)
    throw error
  })

  await transcriber(new Float32Array(INPUT_SAMPLE_RATE)) // Compile shaders

  llm = await AutoModelForCausalLM.from_pretrained(
    'onnx-community/Qwen2.5-0.5B-Instruct-ONNX',
    {
      dtype: await isWebGPUSupported() ? 'q4f16' : 'int8',
      device: await isWebGPUSupported() ? 'webgpu' : 'wasm',
      progress_callback: progress => globalThis.postMessage({ type: 'progress', data: { message: progress } } satisfies WorkerMessageEventProgress),
    },
  ).catch((error: Error) => {
    globalThis.postMessage({ type: 'error', data: { error, message: error.message } } satisfies WorkerMessageEventError<Error>)
    throw error
  })

  tokenizer = await AutoTokenizer.from_pretrained(
    'onnx-community/Qwen2.5-0.5B-Instruct-ONNX',
  ).catch((error: Error) => {
    globalThis.postMessage({ type: 'error', data: { error, message: error.message } } satisfies WorkerMessageEventError<Error>)
    throw error
  })

  await llm.generate({ ...tokenizer('x'), max_new_tokens: 1 }) // Compile shaders

  globalThis.postMessage({
    type: 'status',
    data: {
      status: 'ready',
      message: 'Ready!',
      voices: tts.voices,
    },
  } as WorkerMessageEventStatus)
}

loadModels()

/**
 * Perform Voice Activity Detection (VAD)
 * @param buffer The new audio buffer
 * @returns `true` if the buffer is speech, `false` otherwise.
 */
async function vad(buffer?: Float32Array): Promise<boolean> {
  if (!buffer) {
    // Possibly closed or interrupted
    return false
  }

  const input = new Tensor('float32', buffer, [1, buffer.length])

  const { stateN, output } = await silero_vad({ input, sr, state })
  state = stateN // Update state

  const isSpeech = output.data[0]

  // Use heuristics to determine if the buffer is speech or not
  return (
    // Case 1: We are above the threshold (definitely speech)
    isSpeech > SPEECH_THRESHOLD
    // Case 2: We are in the process of recording, and the probability is above the negative (exit) threshold
    || (isRecording && isSpeech >= EXIT_THRESHOLD)
  )
}

interface SpeechData {
  start: number
  end: number
  duration: number
}

type BatchEncodingItem = number[] | number[][] | Tensor
/**
 * Holds the output of the tokenizer's call function.
 */
interface BatchEncoding {
  /**
   * List of token ids to be fed to a model.
   */
  input_ids: BatchEncodingItem
  /**
   * List of indices specifying which tokens should be attended to by the model.
   */
  attention_mask: BatchEncodingItem
  /**
   * List of token type ids to be fed to a model.
   */
  token_type_ids?: BatchEncodingItem
}

/**
 * Transcribe the audio buffer
 * @param buffer The audio buffer
 * @param _data Additional data
 */
async function speechToSpeech(buffer: Float32Array, _data: SpeechData): Promise<void> {
  isPlaying = true

  // 1. Transcribe the audio from the user
  const result = await transcriber(buffer)
  const text = (result as { text: string }).text.trim()

  if (['', '[BLANK_AUDIO]'].includes(text)) {
    // If the transcription is empty or a blank audio, we skip the rest of the processing
    return
  }

  messages.push({ role: 'user', content: text })

  // Set up text-to-speech streaming
  const splitter = new TextSplitterStream()
  const stream = tts!.stream(splitter, { voice });
  (async () => {
    for await (const { text, audio } of stream) {
      globalThis.postMessage({ type: 'output', data: { text, result: audio } } satisfies WorkerMessageEventOutput)
    }
  })()

  // 2. Generate a response using the LLM
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
  }) as BatchEncoding

  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      splitter.push(text)
    },
    token_callback_function: () => {},
  })

  stopping_criteria = new InterruptableStoppingCriteria()
  type GenerationFunctionParameters = Parameters<typeof llm.generate>[0] & Record<string, any>

  const generatedRes = await llm.generate({
    ...inputs,
    past_key_values: past_key_values_cache,
    do_sample: false, // TODO: do_sample: true is bugged (invalid data location on top-k sample)
    max_new_tokens: 1024,
    streamer,
    stopping_criteria: stopping_criteria as unknown as StoppingCriteriaList,
    return_dict_in_generate: true,
  } as GenerationFunctionParameters)

  const { past_key_values, sequences } = generatedRes as CausalLMOutputWithPast & { sequences: Tensor }
  past_key_values_cache = past_key_values

  // Finally, close the stream to signal that no more text will be added.
  splitter.close()

  const decoded = tokenizer.batch_decode(
    // TODO: fix null as any
    sequences.slice(null, [(inputs.input_ids as Tensor).dims[1], null as any]),
    { skip_special_tokens: true },
  )

  messages.push({ role: 'assistant', content: decoded[0] })
}

// Track the number of samples after the last speech chunk
let postSpeechSamples = 0
function resetAfterRecording(offset = 0): void {
  globalThis.postMessage({
    type: 'status',
    data: {
      status: 'recording_end',
      message: 'Transcribing...',
      duration: 'until_next',
    },
  } satisfies WorkerMessageEventStatus)

  BUFFER.fill(0, offset)
  bufferPointer = offset
  isRecording = false
  postSpeechSamples = 0
}

function dispatchForTranscriptionAndResetAudioBuffer(overflow?: Float32Array): void {
  // Get start and end time of the speech segment, minus the padding
  const now = Date.now()
  const end
    = now - ((postSpeechSamples + SPEECH_PAD_SAMPLES) / INPUT_SAMPLE_RATE) * 1000
  const start = end - (bufferPointer / INPUT_SAMPLE_RATE) * 1000
  const duration = end - start
  const overflowLength = overflow?.length ?? 0

  // Send the audio buffer to the worker
  const buffer = BUFFER.slice(0, bufferPointer + SPEECH_PAD_SAMPLES)

  const prevLength = prevBuffers.reduce((acc, b) => acc + b.length, 0)
  const paddedBuffer = new Float32Array(prevLength + buffer.length)
  let offset = 0
  for (const prev of prevBuffers) {
    paddedBuffer.set(prev, offset)
    offset += prev.length
  }
  paddedBuffer.set(buffer, offset)
  speechToSpeech(paddedBuffer, { start, end, duration })

  // Set overflow (if present) and reset the rest of the audio buffer
  if (overflow) {
    BUFFER.set(overflow, 0)
  }
  resetAfterRecording(overflowLength)
}

globalThis.onmessage = async (event: MessageEvent) => {
  const { type, buffer } = event.data

  // refuse new audio while playing back
  if (type === 'audio' && isPlaying)
    return

  switch (type) {
    case 'start_call': {
      const name = tts!.voices[voice ?? 'af_heart']?.name ?? 'Heart'
      greet(`Hey there, my name is ${name}! How can I help you today?`)
      return
    }
    case 'end_call':
      messages = [SYSTEM_MESSAGE]
      past_key_values_cache = null
      break
    case 'interrupt':
      stopping_criteria?.interrupt()
      return
    case 'set_voice':
      voice = event.data.voice

      globalThis.postMessage({
        type: 'set_voice_response',
        data: {
          ok: true,
        },
      } satisfies WorkerMessageEventSetVoiceResponse)

      return
    case 'playback_ended':
      isPlaying = false
      return
  }

  const wasRecording = isRecording // Save current state
  const isSpeech = await vad(buffer)

  if (!wasRecording && !isSpeech) {
    // We are not recording, and the buffer is not speech,
    // so we will probably discard the buffer. So, we insert
    // into a FIFO queue with maximum size of PREV_BUFFER_SIZE
    if (prevBuffers.length >= MAX_NUM_PREV_BUFFERS) {
      // If the queue is full, we discard the oldest buffer
      prevBuffers.shift()
    }
    prevBuffers.push(buffer)
    return
  }

  const remaining = BUFFER.length - bufferPointer
  if (buffer.length >= remaining) {
    // The buffer is larger than (or equal to) the remaining space in the global buffer,
    // so we perform transcription and copy the overflow to the global buffer
    BUFFER.set(buffer.subarray(0, remaining), bufferPointer)
    bufferPointer += remaining

    // Dispatch the audio buffer
    const overflow = buffer.subarray(remaining)
    dispatchForTranscriptionAndResetAudioBuffer(overflow)
    return
  }
  else {
    // The buffer is smaller than the remaining space in the global buffer,
    // so we copy it to the global buffer
    BUFFER.set(buffer, bufferPointer)
    bufferPointer += buffer.length
  }

  if (isSpeech) {
    if (!isRecording) {
      // Indicate start of recording
      globalThis.postMessage({
        type: 'status',
        data: {
          status: 'recording_start',
          message: 'Listening...',
          duration: 'until_next',
        },
      } satisfies WorkerMessageEventStatus)
    }

    // Start or continue recording
    isRecording = true
    postSpeechSamples = 0 // Reset the post-speech samples

    return
  }

  postSpeechSamples += buffer.length

  // At this point we're confident that we were recording (wasRecording === true), but the latest buffer is not speech.
  // So, we check whether we have reached the end of the current audio chunk.
  if (postSpeechSamples < MIN_SILENCE_DURATION_SAMPLES) {
    // There was a short pause, but not long enough to consider the end of a speech chunk
    // (e.g., the speaker took a breath), so we continue recording
    return
  }

  if (bufferPointer < MIN_SPEECH_DURATION_SAMPLES) {
    // The entire buffer (including the new chunk) is smaller than the minimum
    // duration of a speech chunk, so we can safely discard the buffer.
    resetAfterRecording()
    return
  }

  dispatchForTranscriptionAndResetAudioBuffer()
}

function greet(text: string): void {
  isPlaying = true

  const splitter = new TextSplitterStream()
  const stream = tts!.stream(splitter, { voice });

  (async () => {
    for await (const { text: chunkText, audio } of stream) {
      globalThis.postMessage({ type: 'output', data: { text: chunkText, result: audio } } satisfies WorkerMessageEventOutput)
    }
  })()

  splitter.push(text)
  splitter.close()
  messages.push({ role: 'assistant', content: text })
}
