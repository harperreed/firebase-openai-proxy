<template>
  <!-- Heading -->
  <div
    class="flex flex-col items-start justify-between gap-x-8 gap-y-4 dark:bg-gray-700/10 bg-blue-100 px-4 py-4 sm:flex-row sm:items-center sm:px-6 lg:px-8"
  >
    <div>
      <div class="flex items-center gap-x-3">
        <div class="flex-none rounded-full dark:bg-green-400/10 p-1 dark:text-green-400">
          <div class="h-2 w-2 rounded-full bg-current" />
        </div>
        <h1 class="flex gap-x-3 text-base leading-7">
          <span class="font-semibold dark:text-white">Planetaria</span>
          <span class="text-gray-600">/</span>
          <span class="font-semibold dark:text-white">mobile-api</span>
        </h1>
      </div>
      <p class="mt-2 text-xs leading-6 dark:text-gray-400">
        Deploys from GitHub via main branch
      </p>
    </div>
    <div
      class="order-first flex-none rounded-full dark:bg-indigo-400/10 px-2 py-1 text-xs font-medium dark:text-indigo-400 ring-1 ring-inset dark:ring-indigo-400/30 sm:order-none"
    >
      Production
    </div>
  </div>
</template>

<script setup>
// Footer logic (if any)
</script>
