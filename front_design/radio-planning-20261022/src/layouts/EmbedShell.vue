<template>
  <div class="agent-embed" data-embedded-module>
    <div class="embed-content" :class="{ 'embed-map-content': mapPage }">
      <AppShell embedded />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide } from 'vue';
import { routeLocationKey, routerKey, useRoute, useRouter } from 'vue-router';
import AppShell from './AppShell.vue';
import { createEmbeddedRouter, modulePath, moduleRoute } from '../config/embedded-pages';

const actualRoute = useRoute();
const actualRouter = useRouter();
// The shared business assembly keeps its own dialogs, request guards and runtime parameters.
// Its original logical route remains stable while every navigation stays in this iframe namespace.
provide(routeLocationKey, moduleRoute(actualRoute));
provide(routerKey, createEmbeddedRouter(actualRouter));
provide('embeddedModule', true);
const mapPage = computed(() => ['/situation', '/gis-workbench'].includes(modulePath(actualRoute.path)));

let mounted = false;
let ownedHtmlClass = false;
let ownedBodyClass = false;
onMounted(() => {
  mounted = true;
  ownedHtmlClass = !document.documentElement.classList.contains('agent-embed-mode');
  ownedBodyClass = !document.body.classList.contains('agent-embed-mode');
  document.documentElement.classList.add('agent-embed-mode');
  document.body.classList.add('agent-embed-mode');
});
onBeforeUnmount(() => {
  if (!mounted) return;
  if (ownedHtmlClass) document.documentElement.classList.remove('agent-embed-mode');
  if (ownedBodyClass) document.body.classList.remove('agent-embed-mode');
});
</script>

<style scoped>
.agent-embed { width: 100%; height: 100%; min-height: 0; }
.embed-content { width: 100%; height: 100%; min-height: 0; overflow: auto; }
</style>
