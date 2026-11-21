#!/usr/bin/env node
/**
 * Проверка совместимости ядра из командной строки: `pi-harness-check`.
 *
 * Зачем отдельный вход, если есть `/cycle`: отказ должен быть проверяемым без интерактивной сессии.
 * CI потребителя (и наши тесты) получают код возврата и текст с обеими версиями — контракт из
 * ADR 0008 ядра («несовместимая версия — код 1 и обе версии в тексте»).
 *
 * Коды выхода: `0` — совместимо; `1` — ядро не установлено или версия вне диапазона;
 * `2` — ошибка параметров (неизвестный диапазон).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCompatibility } from '../src/compat.mjs';
import { CORE_PACKAGE, resolveCoreState } from '../src/core.mjs';

const SELF = dirname(fileURLToPath(import.meta.url));

/**
 * Свой диапазон совместимости из `package.json`.
 * @returns {string} диапазон
 */
function ownRange() {
  const manifest = JSON.parse(readFileSync(join(SELF, '..', 'package.json'), 'utf8'));
  return manifest?.peerDependencies?.[CORE_PACKAGE];
}

const range = ownRange();
const state = resolveCoreState({ cwd: process.cwd() });

try {
  const result = checkCompatibility({ coreVersion: state.installedVersion, range });
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
