import type { ProgressInfo, RawAudio } from '@huggingface/transformers'
import type { WorkerMessageEvent as SharedWorkerMessageEvent } from '@xsai-transformers/shared/worker'
import type { Voices } from './kokoro'

export type WorkerMessageEventProgress = SharedWorkerMessageEvent<{ message: ProgressInfo }, 'progress'>
export type WorkerMessageEventInfo = SharedWorkerMessageEvent<{ message: string, duration?: 'until_next' }, 'info'>
export type WorkerMessageEventError<E = unknown> = SharedWorkerMessageEvent<{ error?: E, message?: string }, 'error'>
export type WorkerMessageEventStatus = SharedWorkerMessageEvent<{
  status: 'loading' | 'ready' | 'recording_end' | 'transcribing' | 'recording_start'
  message?: string
  voices?: Readonly<Voices>
  duration?: 'until_next'
}, 'status'>
export type WorkerMessageEventOutput = SharedWorkerMessageEvent<{ text: string, result: RawAudio }, 'output'>

export type WorkerMessageEvent =
| WorkerMessageEventProgress | WorkerMessageEventInfo | WorkerMessageEventError | WorkerMessageEventStatus | WorkerMessageEventOutput
