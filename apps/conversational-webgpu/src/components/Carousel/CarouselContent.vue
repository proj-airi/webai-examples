<script setup lang="ts">
import type { WithClassAsProps } from '../../types/carousel'

import { useCarousel } from '../../composables/use-carousel'

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<WithClassAsProps>()

const { carouselRef, orientation } = useCarousel()
</script>

<template>
  <div ref="carouselRef" class="h-full">
    <div
      class="flex" :class="[
        orientation !== 'horizontal' ? '-mt-4 flex-col' : '',
        props.class,
      ]"
      v-bind="$attrs"
    >
      <slot />
    </div>
  </div>
</template>
