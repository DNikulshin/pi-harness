/**
 * Сверка версии ядра `@dnikulshin/harness` с диапазоном из `peerDependencies`.
 *
 * Зачем свой разбор: адаптер объявляет совместимость диапазоном (`^0.2.0`), а ядро — обычный
 * пакет реестра, у которого номер читается из `package.json`. Тянуть `semver` ради четырёх форм
 * записи — зависимость без обоснования, поэтому поддержаны ровно те формы, которые мы сами
 * объявляем: `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` и точный `X.Y.Z`. Неизвестная форма — ошибка
 * `RangeError`: молчаливое «считаем совместимым» опаснее отказа.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

/**
 * Разбор версии `X.Y.Z` (предрелизные суффиксы отбрасываются: 0.3.0-rc.1 старше 0.3.0).
 * @param {string} text версия
 * @returns {{major: number, minor: number, patch: number, prerelease: string | null} | null}
 *   `null`, если строка не версия
 */
export function parseVersion(text) {
  const match = VERSION.exec(text.trim());
  if (match === null) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Сравнение версий: как в semver, но без учёта предусловий релиза как особого порядка.
 * @param {string} left версия
 * @param {string} right версия
 * @returns {-1 | 0 | 1} знак разницы
 */
export function compareVersions(left, right) {
  const a = requireVersion(left, 'левая версия');
  const b = requireVersion(right, 'правая версия');

  for (const field of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }

  return 0;
}

/**
 * Диапазон совместимости.
 * @typedef {{kind: 'caret' | 'tilde' | 'gte' | 'exact', version: string}} Range
 */

/**
 * Разбор диапазона.
 * @param {string} text диапазон из `peerDependencies`
 * @returns {Range} разобранный диапазон
 * @throws {RangeError} если форма не поддержана (`||`, `*`, пробелы-конъюнкции, `-range`)
 */
export function parseRange(text) {
  const trimmed = text.trim();
  /** @type {ReadonlyArray<readonly [string, string]>} */
  const candidates = [
    ['^', 'caret'],
    ['~', 'tilde'],
    ['>=', 'gte'],
  ];

  for (const [prefix, kind] of candidates) {
    if (trimmed.startsWith(prefix)) {
      const version = trimmed.slice(prefix.length).trim();
      if (parseVersion(version) === null) {
        throw new RangeError(`диапазон ${trimmed}: "${version}" не является версией X.Y.Z`);
      }

      return { kind: /** @type {Range['kind']} */ (kind), version };
    }
  }

  if (parseVersion(trimmed) === null) {
    throw new RangeError(`диапазон ${trimmed} не поддержан`);
  }

  return { kind: 'exact', version: trimmed };
}

/**
 * Попадает ли версия в диапазон.
 * @param {string} coreVersion версия установленного ядра
 * @param {Range} range разобранный диапазон
 * @returns {boolean} `true`, если совместима
 */
export function satisfies(coreVersion, range) {
  const core = requireVersion(coreVersion, 'версия ядра');
  const bound = requireVersion(range.version, 'граница диапазона');
  const order = compareVersions(coreVersion, range.version);

  switch (range.kind) {
    case 'exact':
      return order === 0;
    case 'gte':
      return order >= 0;
    case 'tilde':
      // ~X.Y.Z — патчи этой минорной ветки.
      return order >= 0 && core.major === bound.major && core.minor === bound.minor;
    case 'caret':
      if (order < 0) return false;
      // ^0.Y.Z — только эта минорная ветка: в 0.x минор ломает API (semver, правило 4).
      if (bound.major === 0) {
        if (bound.minor === 0)
          return core.major === 0 && core.minor === 0 && core.patch === bound.patch;
        return core.major === 0 && core.minor === bound.minor;
      }
      return core.major === bound.major;
  }
}

/**
 * Итог сверки для показа человеку.
 * @typedef {{ok: boolean, message: string}} Compatibility
 */

/**
 * Проверка совместимости с готовым текстом для `ui.notify` и для CLI.
 * @param {{coreVersion: string | null, range: string}} params версия ядра и диапазон
 * @returns {Compatibility} итог и текст
 */
export function checkCompatibility({ coreVersion, range }) {
  const parsed = parseRange(range);

  if (coreVersion === null) {
    return {
      ok: false,
      message:
        `Ядро @dnikulshin/harness не установлено в проекте (нужен диапазон ${range}). ` +
        'Установите: npm i -D @dnikulshin/harness (или pnpm add -D @dnikulshin/harness).',
    };
  }

  if (parseVersion(coreVersion) === null) {
    return {
      ok: false,
      message: `Версия ядра не читается: "${coreVersion}". Ожидается X.Y.Z, диапазон адаптера ${range}.`,
    };
  }

  if (satisfies(coreVersion, parsed)) {
    return { ok: true, message: `Ядро @dnikulshin/harness ${coreVersion} совместимо (${range}).` };
  }

  return {
    ok: false,
    message:
      `Ядро @dnikulshin/harness ${coreVersion} несовместимо: адаптер требует ${range}. ` +
      'Обновите ядро или поставьте версию адаптера под вашу версию ядра.',
  };
}

/**
 * Разбор версии с отказом вместо `null`.
 * @param {string} text версия
 * @param {string} label что это за версия — для текста ошибки
 * @returns {{major: number, minor: number, patch: number, prerelease: string | null}} версия
 * @throws {RangeError} если строка не версия
 */
function requireVersion(text, label) {
  const parsed = parseVersion(text);
  if (parsed === null) throw new RangeError(`${label}: "${text}" не является версией X.Y.Z`);

  return parsed;
}
