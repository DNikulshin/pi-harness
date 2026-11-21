/** Имя пакета ядра в реестре. */
export declare const CORE_PACKAGE = "@dnikulshin/harness";
/** Артефакт установки шаблонов: версия и дайджесты. */
export declare const VERSION_ARTIFACT: string;
/**
 * Корень проекта: ближайший вверх каталог с `.pi/` или `package.json`.
 *
 * Отдельная функция, потому что Pi запускает расширение из произвольного каталога сессии, а
 * артефакты цикла лежат в корне проекта.
 * @param {string} startDir каталог, с которого начинается поиск (обычно `cwd`)
 * @returns {string | null} корень проекта или `null`, если ни `.pi/`, ни `package.json` не найдены
 */
export declare function findProjectRoot(startDir: string): string | null;
/**
 * Версия установленного ядра по `package.json` пакета.
 * @param {string} root корень проекта
 * @returns {string | null} версия или `null`, если пакета нет или он без версии
 */
export declare function readInstalledCoreVersion(root: string): string | null;
export type VersionArtifact = {
    /**
     * версия, записанная при установке шаблонов
     */
    version: string | null;
    /**
     * дайджесты поставленных файлов
     */
    templates: Record<string, string>;
    /**
     * текст ошибки чтения (файл битый) — иначе `null`
     */
    error: string | null;
};
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
export declare function readHarnessVersion(root: string): VersionArtifact | null;
export type CoreState = {
    /**
     * корень проекта
     */
    root: string | null;
    /**
     * версия из `node_modules`
     */
    installedVersion: string | null;
    /**
     * версия из `.pi/harness.version`
     */
    artifactVersion: string | null;
    /**
     * ошибка чтения артефакта
     */
    artifactError: string | null;
    /**
     * расхождение установленной и записанной версий
     */
    drift: boolean;
};
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
export declare function resolveCoreState({ cwd }?: {
    cwd?: string;
}): CoreState;
