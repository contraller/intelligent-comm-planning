import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import tsParser from '@typescript-eslint/parser';

// 本轮只检查 Vue 块顺序，不将其他历史写法纳入自动整改范围。
export default [
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
    },
    plugins: { vue },
    rules: {
      'vue/block-order': ['error', { order: ['template', 'script', 'style'] }],
    },
  },
];
