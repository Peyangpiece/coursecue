// ESLint：間違いの検出だけ（整形は Prettier）。npm run lint
import js from '@eslint/js';
import globals from 'globals';
// 画面のスクリプト（dist）はモジュールではなく <script> で順に読むので、app.js と timetable.js は大域を共有する
const shared = {
  // app.js が定義し timetable.js が使う
  academicCalendar: 'readonly',
  render: 'readonly',
  key: 'writable',
  courseIdOf: 'readonly',
  state: 'writable',
  courses: 'writable',
  esc: 'readonly',
  savePersonal: 'readonly',
  job: 'readonly',
  removedCourse: 'readonly',
  panel: 'readonly',
  materialLink: 'readonly',
  manaboLink: 'readonly',
  openDrawer: 'readonly',
  toast: 'readonly',
  // timetable.js が定義し app.js が使う
  openSession: 'readonly',
  openCourseConfig: 'readonly',
  openAttendance: 'readonly',
  reapplyPending: 'readonly',
  courseConfig: 'readonly',
  attendanceSummary: 'readonly',
  courseDates: 'readonly',
  todayISO: 'readonly',
  modeLabel: 'readonly',
  dayLabel: 'readonly',
  todayPanel: 'readonly',
  timetableView: 'readonly',
  attendanceView: 'readonly',
  bindTimetable: 'readonly',
  // profile-form.js
  ProfileForm: 'readonly'
};
const rules = {
  'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_'}],
  'no-empty': ['error', {allowEmptyCatch: true}],
  // 日本語の全角空白は文字列・コメントに出てくる
  'no-irregular-whitespace': ['error', {skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true}],
  // ファイル名の正規化（\x00-\x1f）や文字列の中のエスケープは意図したもの
  'no-control-regex': 'off',
  'no-useless-escape': 'off'
};
export default [
  {ignores: ['node_modules/', 'release/', 'dist/academic-calendar.json', 'dist/jsqr.js']},
  js.configs.recommended,
  {
    files: [
      'local/**/*.js',
      'server/**/*.js',
      'desktop/**/*.js',
      'tests/**/*.js',
      'eslint.config.js',
      'dist/credentials.js'
    ],
    languageOptions: {ecmaVersion: 2024, sourceType: 'module', globals: {...globals.node, ...globals.browser}},
    rules
  },
  {
    files: ['desktop/**/*.cjs'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node},
    rules
  },
  {
    files: ['dist/**/*.js'],
    ignores: ['dist/credentials.js'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'script', globals: {...globals.browser, ...shared}},
    rules: {
      ...rules,
      // ファイルの先頭で定義する関数・変数はほかのファイルから使う
      'no-unused-vars': ['error', {vars: 'local', args: 'none', caughtErrors: 'none', ignoreRestSiblings: true}],
      'no-redeclare': ['error', {builtinGlobals: false}]
    }
  }
];
