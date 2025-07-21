<script setup lang="ts">
withDefaults(defineProps<{
  percentage?: number
  total?: number
}>(), {
  percentage: 0,
})
</script>

<template>
  <div
    bg="neutral-500/40 dark:neutral-900/70"
    border="neutral-400/40 dark:neutral-700/50 1 solid"
    transition="all duration-300 ease-in-out"
    h-full overflow-hidden rounded-full backdrop-blur-lg
  >
    <div h-full bg="white dark:neutral-200" w="[100%]" :style="{ transform: `translateX(-${Math.max(0, 100 - percentage)}%)` }" />
  </div>
</template>
