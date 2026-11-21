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
 * Границы (ADR 0004/0008 ядра): адаптер не импортирует `scripts/**` и `scripts/lib/**` ядра.
 * Всё, что ему нужно, — `bin`-команды ядра (`node_modules/.bin/harness-*`) и файлы `.pi/`:
 * сверка импортов живёт в тесте (`test/imports.test.mjs`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCompatibility } from './compat.mjs';
import { CORE_PACKAGE, resolveCoreState } from './core.mjs';
import { callDriver, describePlan, parseStepPlan } from './driver.mjs';
import { runCycle } from './run.mjs';

const SELF = dirname(fileURLToPath(import.meta.url));
const RANGE = readOwnRange();

/** Подкоманды `/cycle`. */
export const SUBCOMMANDS = Object.freeze(['next', 'run', 'help']);

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
    'Остановки: spawn, handoff, stop, blocked. Переход в PR и ESCALATED спрашивает подтверждение.',
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
 * Фабрика расширения Pi. Экспорт по умолчанию — то, что загружает Pi.
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi API расширения
 */
export default function extension(pi) {
  pi.registerCommand('cycle', {
    description: 'Цикл ядра: состояние, шаг и исполнение детерминированных шагов',
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
