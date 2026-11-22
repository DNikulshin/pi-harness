/**
 * `/cycle` — вход в детерминированный цикл ядра `@dnikulshin/harness`.
 *
 * Шаг 1 (issue #1): регистрация команды и проверка совместимости. Команда не начинает цикл, если
 * установленное ядро вне `peerDependencies` этого пакета: отказ с обеими версиями лучше, чем
 * падение на середине протокола, где у потребителя уже есть артефакты незавершённой задачи.
 *
 * Шаг 2 (issue #3): `next` показывает шаг и ожидание, `run` исполняет детерминированные шаги,
 * останавливаясь на `spawn`/`handoff`/`stop`/`blocked` и спрашивая подтверждение на входе в
 * `PR`/`ESCALATED`. Маршрутизацию решает ядро — адаптер её не дублирует.
 *
 * Шаг 3 (issue #4): `state`, `gates`, `decision`, `evidence` показывают артефакты цикла — только
 * чтение, без правки стадий (ADR 0006/0008 ядра).
 *
 * Границы (ADR 0004/0008 ядра): адаптер не импортирует `scripts/**` и `scripts/lib/**` ядра.
 * Всё, что ему нужно, — `bin`-команды ядра (`node_modules/.bin/harness-*`) и файлы `.pi/`:
 * сверка импортов живёт в тесте (`test/imports.test.mjs`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVIDENCE_DIR,
  STATE_FILE,
  artifactIteration,
  describeDecision,
  describeEvidence,
  describeEvidenceFile,
  describeGates,
  describeState,
  findCycleDir,
  iterationFileName,
  listEvidence,
  parseIteration,
  readArtifact,
  readEvidenceFile,
  resolveCycleDir,
} from './artifacts.mjs';
import { checkCompatibility } from './compat.mjs';
import { CORE_PACKAGE, resolveCoreState } from './core.mjs';
import { callDriver, describePlan, parseStepPlan } from './driver.mjs';
import { runCycle } from './run.mjs';

const SELF = dirname(fileURLToPath(import.meta.url));
const RANGE = readOwnRange();

/** Подкоманды `/cycle`. */
export const SUBCOMMANDS = Object.freeze([
  'next',
  'run',
  'state',
  'gates',
  'decision',
  'evidence',
  'help',
]);

/**
 * Диапазон совместимости берётся из своего же `package.json` — один источник правды.
 * @returns {string} диапазон ядра (`^0.2.0`)
 */
function readOwnRange() {
  const manifest = JSON.parse(readFileSync(join(SELF, '..', 'package.json'), 'utf8'));
  const range = manifest?.peerDependencies?.[CORE_PACKAGE];
  if (typeof range !== 'string') {
    throw new Error(`package.json: нет peerDependencies["${CORE_PACKAGE}"]`);
  }

  return range;
}

/**
 * Текст о состоянии цикла для человека.
 * @param {import('./core.mjs').CoreState} state снимок состояния ядра
 * @returns {string} строка статуса
 */
export function statusLine(state) {
  if (state.root === null) {
    return 'Корень проекта не найден: нет ни `.pi/`, ни `package.json` вверх по дереву. Запустите `/cycle` из проекта.';
  }

  const parts = [`корень: ${state.root}`];
  parts.push(`ядро: ${state.installedVersion ?? 'не установлено'}`);
  if (state.artifactVersion !== null) {
    parts.push(`шаблоны: ${state.artifactVersion}`);
  } else if (state.artifactError !== null) {
    parts.push(`шаблоны: файл не читается (${state.artifactError})`);
  } else {
    parts.push('шаблоны: не ставились');
  }

  return parts.join(' · ');
}

/**
 * Подсказка по подкомандам.
 * @returns {string} текст
 */
export function helpText() {
  return [
    '/cycle next — что делать прямо сейчас (стадия, шаг, ожидание, команда)',
    '/cycle run — исполнить детерминированные шаги до первой остановки',
    '/cycle state — состояние цикла: стадия, шаг, итерация, чего ждём',
    '/cycle gates [n] — гейты итерации: что прошло, код возврата, первые строки вывода',
    '/cycle decision [n] — решение итерации: действие, причина, куда возврат',
    '/cycle evidence [путь] — файлы пакета оценщика с размерами; путь — показать содержимое',
    '/cycle help — эта подсказка',
    'Остановки: spawn, handoff, stop, blocked. Переход в PR и ESCALATED спрашивает подтверждение.',
    'Артефакты только читаются: стадии меняет CLI ядра, а не адаптер.',
  ].join('\n');
}

/**
 * Первое слово аргументов — подкоманда.
 * @param {string} args аргументы команды
 * @returns {string} подкоманда (по умолчанию `next`)
 */
export function parseSubcommand(args) {
  const [first] = args.trim().split(/\s+/u);
  return first === undefined || first === '' ? 'next' : first;
}

/**
 * Аргументы подкоманды: всё после первого слова. `evidence` берёт путь целиком, поэтому
 * пробелы в нём сохраняются.
 * @param {string} args аргументы команды
 * @returns {string[]} остаток аргументов
 */
export function parseRest(args) {
  const trimmed = args.trim();
  const space = trimmed.search(/\s/u);

  return space === -1
    ? []
    : trimmed
        .slice(space + 1)
        .trim()
        .split(/\s+/u)
        .filter((part) => part !== '');
}

/**
 * Фабрика расширения Pi. Экспорт по умолчанию — то, что загружает Pi.
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi API расширения
 */
export default function extension(pi) {
  pi.registerCommand('cycle', {
    description:
      'Цикл ядра: состояние, шаг, исполнение шагов и артефакты (state, gates, decision, evidence)',
    handler: async (args, ctx) => {
      const state = resolveCoreState({ cwd: process.cwd() });
      const compatibility = checkCompatibility({
        coreVersion: state.installedVersion,
        range: RANGE,
      });

      if (!compatibility.ok) {
        ctx.ui.notify(statusLine(state), 'error');
        ctx.ui.notify(compatibility.message, 'error');
        return;
      }

      if (state.drift) {
        ctx.ui.notify(
          `Версия ядра в node_modules (${state.installedVersion}) и в шаблонах (${state.artifactVersion}) расходятся: ` +
            'переустановите шаблоны (`npx @dnikulshin/harness init`), иначе артефакты и код будут из разных версий.',
          'warning',
        );
      }

      const root = state.root ?? process.cwd();
      const sub = parseSubcommand(args);
      const rest = parseRest(args);

      if (sub === 'help') {
        ctx.ui.notify(helpText(), 'info');
        return;
      }

      if (sub === 'next') {
        await showNext({ root, notify: (text, level) => ctx.ui.notify(text, level) });
        return;
      }

      if (sub === 'run') {
        await runCycle({
          next: () => callDriver({ root, args: ['next'] }),
          runOne: () => callDriver({ root, args: ['run', '--max-steps', '1'] }),
          confirm: (text) => ctx.ui.confirm('Подтверждение перехода', text),
          notify: (text, level) => ctx.ui.notify(text, level),
        });
        return;
      }

      const notify =
        /** @type {(text: string, level: import('./driver.mjs').NotifyLevel) => void} */ (
          (text, level) => ctx.ui.notify(text, level)
        );

      if (sub === 'state') {
        await showState({ root, notify });
        return;
      }

      if (sub === 'gates') {
        await showGates({ root, iteration: rest[0], notify });
        return;
      }

      if (sub === 'decision') {
        await showDecision({ root, iteration: rest[0], notify });
        return;
      }

      if (sub === 'evidence') {
        await showEvidence({ root, path: rest.join(' '), notify });
        return;
      }

      ctx.ui.notify(`Неизвестная подкоманда «${sub}»: ${SUBCOMMANDS.join(' | ')}`, 'error');
    },
  });
}

/**
 * Показать текущий шаг.
 * @param {{root: string, notify: (text: string, level: import('./driver.mjs').NotifyLevel) => void}} deps зависимости
 * @returns {Promise<void>} ничего
 */
async function showNext({ root, notify }) {
  const result = await callDriver({ root, args: ['next'] });
  try {
    notify(describePlan(parseStepPlan(result.json)), result.code === 0 ? 'info' : 'warning');
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error');
    if (result.stderr !== '') notify(result.stderr, 'error');
  }
}

/**
 * Каталог цикла для показа артефактов.
 *
 * Сначала спрашиваем драйвер: `cycle.dir` в его ответе — часть контракта (§5.3a ядра), и правила
 * активности каталогов живут там же. Если драйвер не ответил (битый `state.json`, цикл не
 * начинался), ищем единственный каталог в `.pi/artifacts/` и говорим об этом: показать артефакты
 * как есть полезнее, чем отказать — рушится именно тот разбор, за которым позвали команду.
 * @param {{root: string, notify: (text: string, level: import('./driver.mjs').NotifyLevel) => void}} deps
 *   зависимости
 * @returns {Promise<string | null>} каталог цикла или `null`, если показать нечего
 */
async function cycleDirFor({ root, notify }) {
  const result = await callDriver({ root, args: ['next'] });
  try {
    const dir = resolveCycleDir({ root, dir: parseStepPlan(result.json).cycleDir });
    if (dir !== null) return dir;
  } catch {
    // Ниже — резервный путь: текст отказа драйвера уже не нужен целиком, но причину покажем.
  }

  const fallback = findCycleDir(root);
  if (fallback.dir === null) {
    if (result.stderr !== '') notify(result.stderr, 'warning');
    notify(fallback.error ?? 'каталог цикла не найден', 'error');
    return null;
  }

  notify(
    `Драйвер не ответил, показываю артефакты напрямую из \`.pi/artifacts/\`: стадии меняет CLI ядра, ` +
      'а не адаптер, поэтому чтение такого каталога безопасно.',
    'warning',
  );

  return fallback.dir;
}

/**
 * Текст с адресом каталога цикла: человеку нужно знать, откуда взяты строки.
 * @param {string} root корень проекта
 * @param {string} dir каталог цикла
 * @param {string} text тело сообщения
 * @returns {string} текст с путём
 */
function withCycleDir(root, dir, text) {
  const shown = relative(root, dir);

  return [`каталог: ${shown === '' ? dir : shown}`, text].join('\n');
}

/**
 * `/cycle state`: состояние цикла по-человечески.
 * @param {{root: string, notify: (text: string, level: import('./driver.mjs').NotifyLevel) => void}} deps
 *   зависимости
 * @returns {Promise<void>} ничего
 */
async function showState({ root, notify }) {
  const dir = await cycleDirFor({ root, notify });
  if (dir === null) return;

  const artifact = readArtifact(dir, STATE_FILE);
  if (artifact.error !== null) {
    notify(withCycleDir(root, dir, `state: ${artifact.error}`), 'error');
    return;
  }

  notify(withCycleDir(root, dir, describeState(artifact.value)), 'info');
}

/**
 * Итерация для `gates`/`decision`: аргумент команды или текущая из `state.json`.
 * @param {string} dir каталог цикла
 * @param {string | undefined} argument аргумент `[n]`
 * @returns {{iteration: number | null, error: string | null}} номер или текст ошибки
 */
function artifactIterationFor(dir, argument) {
  const requested = parseIteration(argument);
  if (requested.error !== null) return requested;
  if (requested.iteration !== null) return requested;

  const state = readArtifact(dir, STATE_FILE);
  const current = artifactIteration(state.value);
  if (current === null) {
    return {
      iteration: null,
      error:
        'текущая итерация не определена (state.json не читается) — укажите номер: /cycle gates <n>',
    };
  }

  return { iteration: current, error: null };
}

/**
 * `/cycle gates [n]`: гейты итерации.
 * @param {{root: string, iteration: string | undefined, notify: (text: string, level: import('./driver.mjs').NotifyLevel) => void}} deps
 *   зависимости
 * @returns {Promise<void>} ничего
 */
async function showGates({ root, iteration, notify }) {
  const dir = await cycleDirFor({ root, notify });
  if (dir === null) return;

  const picked = artifactIterationFor(dir, iteration);
  if (picked.error !== null || picked.iteration === null) {
    notify(withCycleDir(root, dir, picked.error ?? 'номер итерации не определён'), 'error');
    return;
  }

  const file = iterationFileName('gates', picked.iteration);
  const artifact = readArtifact(dir, file);
  if (artifact.error !== null) {
    notify(withCycleDir(root, dir, `${file}: ${artifact.error}`), 'error');
    return;
  }

  notify(withCycleDir(root, dir, describeGates(dir, artifact.value)), 'info');
}

/**
 * `/cycle decision [n]`: решение итерации и его причина.
 * @param {{root: string, iteration: string | undefined, notify: (text: string, level: import('./driver.mjs').NotifyLevel) => void}} deps
 *   зависимости
 * @returns {Promise<void>} ничего
 */
async function showDecision({ root, iteration, notify }) {
  const dir = await cycleDirFor({ root, notify });
  if (dir === null) return;

  const picked = artifactIterationFor(dir, iteration);
  if (picked.error !== null || picked.iteration === null) {
    notify(withCycleDir(root, dir, picked.error ?? 'номер итерации не определён'), 'error');
    return;
  }

  const file = iterationFileName('decision', picked.iteration);
  const artifact = readArtifact(dir, file);
  if (artifact.error !== null) {
    notify(withCycleDir(root, dir, `${file}: ${artifact.error}`), 'error');
    return;
  }

  notify(withCycleDir(root, dir, describeDecision(artifact.value)), 'info');
}

/**
 * `/cycle evidence [путь]`: список пакета оценщика или содержимое одного файла.
 * @param {{root: string, path: string, notify: (text: string, level: import('./driver.mjs').NotifyLevel) => void}} deps
 *   зависимости
 * @returns {Promise<void>} ничего
 */
async function showEvidence({ root, path, notify }) {
  const dir = await cycleDirFor({ root, notify });
  if (dir === null) return;

  if (path === '') {
    notify(withCycleDir(root, dir, describeEvidence(listEvidence(dir))), 'info');
    return;
  }

  const file = readEvidenceFile(dir, path);
  if (file.error !== null) {
    notify(withCycleDir(root, dir, `${EVIDENCE_DIR}/${path}: ${file.error}`), 'error');
    return;
  }

  notify(withCycleDir(root, dir, describeEvidenceFile(file)), 'info');
}
