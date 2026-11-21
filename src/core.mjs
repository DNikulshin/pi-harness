/**
 * Где живёт ядро и какая у него версия — только файлы, без импорта внутренностей.
 *
 * Контракт адаптера (ADR 0004/0008 ядра): обращаться к ядру можно через его `bin` и через
 * артефакты в `.pi/`. Поэтому здесь чтение двух источников версии и ничего больше:
 *
 * - `node_modules/@dnikulshin/harness/package.json` — что реально установлено;
 * - `.pi/harness.version` — что записала установка шаблонов (`harness-init`): версия и `sha256`
 *   каждого поставленного файла.
 *
 * Расхождение этих двух версий — не ошибка адаптера: пакет могли обновить без переустановки
 * шаблонов. Адаптер выбирает `package.json` (по нему исполняются `bin`) и сообщает о расхождении.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Имя пакета ядра в реестре. */
export const CORE_PACKAGE = '@dnikulshin/harness';

/** Артефакт установки шаблонов: версия и дайджесты. */
export const VERSION_ARTIFACT = join('.pi', 'harness.version');

/**
 * Корень проекта: ближайший вверх каталог с `.pi/` или `package.json`.
 *
 * Отдельная функция, потому что Pi запускает расширение из произвольного каталога сессии, а
 * артефакты цикла лежат в корне проекта.
 * @param {string} startDir каталог, с которого начинается поиск (обычно `cwd`)
 * @returns {string | null} корень проекта или `null`, если ни `.pi/`, ни `package.json` не найдены
 */
export function findProjectRoot(startDir) {
  let current = resolve(startDir);

  for (;;) {
    if (existsSync(join(current, '.pi')) || existsSync(join(current, 'package.json'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Версия установленного ядра по `package.json` пакета.
 * @param {string} root корень проекта
 * @returns {string | null} версия или `null`, если пакета нет или он без версии
 */
export function readInstalledCoreVersion(root) {
  const file = join(root, 'node_modules', ...CORE_PACKAGE.split('/'), 'package.json');
  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Содержимое `.pi/harness.version`.
 * @typedef {object} VersionArtifact
 * @property {string | null} version версия, записанная при установке шаблонов
 * @property {Record<string, string>} templates дайджесты поставленных файлов
 * @property {string | null} error текст ошибки чтения (файл битый) — иначе `null`
 */

/**
 * Чтение артефакта версии. Битый файл — не падение: адаптер сообщает о нём и продолжает.
 * @param {string} root корень проекта
 * @returns {VersionArtifact | null} `null`, если артефакта нет (шаблоны не ставили)
 */
export function readHarnessVersion(root) {
  const file = join(root, VERSION_ARTIFACT);
  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const templates =
      parsed?.templates && typeof parsed.templates === 'object' ? parsed.templates : {};

    return {
      version: typeof parsed?.version === 'string' ? parsed.version : null,
      templates,
      error: null,
    };
  } catch (error) {
    return {
      version: null,
      templates: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Снимок «где ядро и какая версия» для команды и CLI.
 * @typedef {object} CoreState
 * @property {string | null} root корень проекта
 * @property {string | null} installedVersion версия из `node_modules`
 * @property {string | null} artifactVersion версия из `.pi/harness.version`
 * @property {string | null} artifactError ошибка чтения артефакта
 * @property {boolean} drift расхождение установленной и записанной версий
 */

/**
 * Собрать снимок состояния ядра.
 * @param {{cwd?: string}} [options] каталог старта (по умолчанию `process.cwd()`)
 * @returns {CoreState} снимок
 */
export function resolveCoreState({ cwd = process.cwd() } = {}) {
  const root = findProjectRoot(cwd);
  const installedVersion = root === null ? null : readInstalledCoreVersion(root);
  const artifact = root === null ? null : readHarnessVersion(root);

  return {
    root,
    installedVersion,
    artifactVersion: artifact?.version ?? null,
    artifactError: artifact?.error ?? null,
    drift:
      installedVersion !== null &&
      artifact?.version != null &&
      installedVersion !== artifact.version,
  };
}
