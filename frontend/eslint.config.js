import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * P3-1：代码规范。格式交给 Prettier（eslint-config-prettier 关掉与之冲突的规则），
 * ESLint 只管潜在错误与 Vue 用法。
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // 页面级组件按路由命名（Workbench、Login 等单词名），不强制多词
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  prettier,
)
