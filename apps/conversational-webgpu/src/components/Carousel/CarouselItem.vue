<script setup lang="ts">
import type { WithClassAsProps } from '../../types/carousel'

import { useCarousel } from '../../composables/use-carousel'

const props = defineProps<WithClassAsProps>()

const { orientation } = useCarousel()
</script>

<template>
  <div
    role="group"
    aria-roledescription="slide"
    class="min-w-0 shrink-0 grow-0 basis-full" :class="[
      orientation === 'horizontal' ? 'pl-0' : 'pt-4',
      props.class,
    ]"
  >
    <slot />
  </div>
</template>
