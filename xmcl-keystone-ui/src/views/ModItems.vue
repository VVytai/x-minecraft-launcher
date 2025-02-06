<template>

</template>

<script setup lang="ts">

const props = defineProps<{
  item: ProjectEntry<ModFile>
  selectionMode: boolean
  checked: boolean
  selected: boolean
  itemHeight: number
  hasUpdate?: boolean
  dense?: boolean
  indent?: boolean
  getContextMenuItems?: () => ContextMenuItem[]
  install: (p: ProjectEntry) => Promise<void>
}>()

</script>