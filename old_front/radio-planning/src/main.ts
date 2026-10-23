import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { radioTheme } from './theme/primevue';
import { router } from './router';
import App from './App.vue';
import 'primeicons/primeicons.css';
import 'ol/ol.css';
import './styles/tokens.css';
import './styles/global.css';

createApp(App)
  .use(createPinia())
  .use(router)
  .use(PrimeVue, {
    theme: { preset: radioTheme, options: { darkModeSelector: '.app-dark' } },
    locale: {
      emptyMessage: '暂无数据',
      emptySearchMessage: '未找到匹配项',
      startsWith: '开头为',
      contains: '包含',
      // 沿用控件占位符，分页、关闭和选择播报均使用中文。
      selectionMessage: '已选择 {0} 项',
      emptySelectionMessage: '未选择任何项',
      aria: { close: '关闭', firstPageLabel: '首页', prevPageLabel: '上一页', pageLabel: '第 {page} 页', nextPageLabel: '下一页', lastPageLabel: '末页', rowsPerPageLabel: '每页条数' },
    },
  })
  .mount('#app');
