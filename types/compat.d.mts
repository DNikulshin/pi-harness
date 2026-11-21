/**
 * Сверка версии ядра `@dnikulshin/harness` с диапазоном из `peerDependencies`.
 *
 * Зачем свой разбор: адаптер объявляет совместимость диапазоном (`^0.2.0`), а ядро — обычный
 * пакет реестра, у которого номер читается из `package.json`. Тянуть `semver` ради четырёх форм
 * записи — зависимость без обоснования, поэтому поддержаны ровно те формы, которые мы сами
 * объявляем: `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` и точный `X.Y.Z`. Неизвестная форма — ошибка
 * `RangeError`: молчаливое «считаем совместимым» опаснее отказа.
 */
/**
 * Разбор версии `X.Y.Z` (предрелизные суффиксы отбрасываются: 0.3.0-rc.1 старше 0.3.0).
 * @param {string} text версия
 * @returns {{major: number, minor: number, patch: number, prerelease: string | null} | null}
 *   `null`, если строка не версия
 */
export declare function parseVersion(text: string): {
    major: number;
    minor: number;
    patch: number;
    prerelease: string | null;
} | null;
/**
 * Сравнение версий: как в semver, но без учёта предусловий релиза как особого порядка.
 * @param {string} left версия
 * @param {string} right версия
 * @returns {-1 | 0 | 1} знак разницы
 */
export declare function compareVersions(left: string, right: string): -1 | 0 | 1;
export type Range = {
    kind: 'caret' | 'tilde' | 'gte' | 'exact';
    version: string;
};
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
export declare function parseRange(text: string): Range;
/**
 * Попадает ли версия в диапазон.
 * @param {string} coreVersion версия установленного ядра
 * @param {Range} range разобранный диапазон
 * @returns {boolean} `true`, если совместима
 */
export declare function satisfies(coreVersion: string, range: Range): boolean;
export type Compatibility = {
    ok: boolean;
    message: string;
};
/**
 * Итог сверки для показа человеку.
 * @typedef {{ok: boolean, message: string}} Compatibility
 */
/**
 * Проверка совместимости с готовым текстом для `ui.notify` и для CLI.
 * @param {{coreVersion: string | null, range: string}} params версия ядра и диапазон
 * @returns {Compatibility} итог и текст
 */
export declare function checkCompatibility({ coreVersion, range }: {
    coreVersion: string | null;
    range: string;
}): Compatibility;
