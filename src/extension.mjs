/**
 * `/cycle` — вход в детерминированный цикл ядра `@dnikulshin/harness`.
 *
 * Шаг 1 (issue #1): регистрация команды и проверка совместимости. Команда не начинает цикл, если
 * установленное ядро вне `peerDependencies` этого пакета: отказ с обеими версиями лучше, чем
 * падение на середине протокола, где у потребителя уже есть артефакты незавершённой задачи.
 *
 * Границы (ADR 0004/0008 ядра): адаптер не импортирует `scripts/**` и `scripts/lib/**` ядра.
 * Всё, что ему нужно, — `bin`-команды ядра и файлы `.pi/`: сверка импортов живёт в тесте
 * (`test/imports.test.mjs`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCompatibility } from './compat.mjs';
import { CORE_PACKAGE, resolveCoreState } from './core.mjs';

const SELF = dirname(fileURLToPath(import.meta.url));
const RANGE = readOwnRange();

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
 * Текст о состоянии цикла для человека. Шаг 1 показывает только совместимость и версии: шаг,
 * артефакты и переходы появятся на шагах 2–3.
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
 * Фабрика расширения Pi. Экспорт по умолчанию — то, что загружает Pi.
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi API расширения
 */
export default function extension(pi) {
  pi.registerCommand('cycle', {
    description: 'Цикл ядра: проверка совместимости и состояние (шаг 1)',
    handler: async (_args, ctx) => {
      const state = resolveCoreState({ cwd: process.cwd() });
      const compatibility = checkCompatibility({
        coreVersion: state.installedVersion,
        range: RANGE,
      });

      ctx.ui.notify(statusLine(state), 'info');

      if (!compatibility.ok) {
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

      ctx.ui.notify(compatibility.message, 'info');
    },
  });
}
