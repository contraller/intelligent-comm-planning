import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

// 统一使用 PrimeVue 4 的主题令牌，保持控件与地图工作区一致。
export const radioTheme = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#effaff',
      100: '#d9f2ff',
      200: '#bae7ff',
      300: '#89d7ff',
      400: '#4cbcff',
      500: '#279cf5',
      600: '#1679d3',
      700: '#1763ab',
      800: '#18538c',
      900: '#194573',
      950: '#102b4c',
    },
    colorScheme: {
      dark: {
        surface: {
          0: '#ffffff',
          50: '#eff4fb',
          100: '#d7e2f0',
          200: '#b3c4d9',
          300: '#92a6c1',
          400: '#778ba7',
          500: '#566d8a',
          600: '#334861',
          700: '#24344b',
          800: '#152239',
          900: '#0e192c',
          950: '#080f1e',
        },
      },
    },
  },
});
