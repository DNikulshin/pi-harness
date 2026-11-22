/** Состояние цикла — единственный писатель `cycle-state` (§5.3). */
export declare const STATE_FILE = "state.json";
/** Логи гейтов: `gates/<id>.<n>.log` (§5.5). */
export declare const GATES_LOGS_DIR = "gates";
/** Каталог пакета оценщика (§5.4). */
export declare const EVIDENCE_DIR = "evidence";
/** Сколько первых строк лога гейта печатаем (полный вывод — простыня в TUI). */
export declare const MAX_GATE_LOG_LINES = 5;
/** Потолок одной строки лога: строки бывают «одной строкой на весь отчёт». */
export declare const MAX_GATE_LOG_CHARS = 200;
/** Сколько символов логов гейтов печатаем на всю итерацию. */
export declare const MAX_GATE_LOG_TOTAL_CHARS = 1200;
/** Сколько байт файла `evidence/` показываем по явному запросу. */
export declare const MAX_EVIDENCE_BYTES: number;
/** Сколько строк файла `evidence/` показываем по явному запросу. */
export declare const MAX_EVIDENCE_LINES = 200;
/** Сколько файлов `evidence/` перечисляем: пакет растёт от итерации к итерации. */
export declare const MAX_EVIDENCE_ENTRIES = 200;
export type Artifact = {
    /**
     * разобранное значение (`null`, если файла нет или он битый)
     */
    value: unknown;
    /**
     * текст ошибки — иначе `null`
     */
    error: string | null;
};
/**
 * Разобранный артефакт: значение либо текст ошибки (никогда оба сразу).
 * @typedef {object} Artifact
 * @property {unknown} value разобранное значение (`null`, если файла нет или он битый)
 * @property {string | null} error текст ошибки — иначе `null`
 */
/**
 * Имя файла итерации: `gates.<n>.json` / `decision.<n>.json` (§5.2 ядра).
 * @param {'gates' | 'decision'} kind вид артефакта
 * @param {number} iteration номер итерации
 * @returns {string} имя файла внутри каталога цикла
 */
export declare function iterationFileName(kind: 'gates' | 'decision', iteration: number): string;
/**
 * Номер итерации из аргумента команды: пусто — «текущая», не число — ошибка текстом.
 * @param {string | undefined} text аргумент `[n]`
 * @returns {{iteration: number | null, error: string | null}} номер или текст ошибки
 */
export declare function parseIteration(text: string | undefined): {
    iteration: number | null;
    error: string | null;
};
/**
 * Каталог цикла из ответа драйвера: абсолютный путь берётся как есть, относительный — от корня.
 * @param {{root: string, dir: unknown}} params корень проекта и `cycle.dir`
 * @returns {string | null} каталог или `null`, если драйвер пути не дал
 */
export declare function resolveCycleDir({ root, dir }: {
    root: string;
    dir: unknown;
}): string | null;
/**
 * Резервный поиск каталога цикла: единственный подкаталог `.pi/artifacts/` со `state.json`.
 *
 * Нужен, когда драйвер не ответил (битый `state.json`, цикл ещё не начинался) — показывать
 * артефакты надо и тогда. Правила активности каталога живут в ядре (§5.3), поэтому фильтра по
 * стадии здесь намеренно нет: показать артефакты завершённого цикла полезно, а переходы всё
 * равно делает CLI. Путь `.pi/artifacts/` — значение по умолчанию конфига ядра; если проект
 * переопределил `paths.artifactsDir`, работает только путь драйвера.
 * @param {string} root корень проекта
 * @returns {{dir: string | null, error: string | null}} каталог цикла или текст ошибки
 */
export declare function findCycleDir(root: string): {
    dir: string | null;
    error: string | null;
};
/**
 * Разбор JSON-артефакта каталога цикла.
 *
 * Содержимое файла в текст ошибки не попадает (правило «секреты не печатаем»): только имя файла
 * и что с ним не так.
 * @param {string} dir каталог цикла
 * @param {string} file имя файла внутри каталога
 * @returns {Artifact} значение и ошибка
 */
export declare function readArtifact(dir: string, file: string): Artifact;
/**
 * Номер итерации из разобранного `state.json` — по умолчанию для `gates`/`decision`.
 * @param {unknown} state разобранный `state.json`
 * @returns {number | null} итерация или `null`, если поля нет
 */
export declare function artifactIteration(state: unknown): number | null;
/**
 * Первые строки лога гейта: `gates/<id>.<n>.log` (§5.5 ядра).
 *
 * Читается только начало файла: логи ядра маскируются при захвате, но печатать целиком их всё
 * равно нельзя — это простыни, в которых человек не найдёт строку отказа.
 * @param {string} dir каталог цикла
 * @param {string} logPath путь лога из `gates.<n>.json` (относительный)
 * @returns {{lines: string[], error: string | null}} первые строки или текст ошибки
 */
export declare function gateLogHead(dir: string, logPath: string): {
    lines: string[];
    error: string | null;
};
/**
 * Человекочитаемый `state.json`: стадия, шаг, итерация, чего цикл ждёт.
 * @param {unknown} value разобранный `state.json`
 * @returns {string} текст для `ui.notify`
 */
export declare function describeState(value: unknown): string;
/**
 * Человекочитаемые гейты итерации: что прошло, что нет, код возврата, первые строки лога.
 * @param {string} dir каталог цикла (для логов `gates/<id>.<n>.log`)
 * @param {unknown} value разобранный `gates.<n>.json`
 * @returns {string} текст для `ui.notify`
 */
export declare function describeGates(dir: string, value: unknown): string;
/**
 * Человекочитаемое решение итерации: действие, причина, куда возврат.
 * @param {unknown} value разобранный `decision.<n>.json`
 * @returns {string} текст для `ui.notify`
 */
export declare function describeDecision(value: unknown): string;
/**
 * Список файлов `evidence/` с размерами: что ушло оценщику.
 * @param {string} dir каталог цикла
 * @returns {{files: Array<{path: string, bytes: number}>, truncated: boolean, error: string | null}}
 *   файлы (пути относительно `evidence/`), признак обрезки списка и текст ошибки
 */
export declare function listEvidence(dir: string): {
    files: Array<{
        path: string;
        bytes: number;
    }>;
    truncated: boolean;
    error: string | null;
};
/**
 * Человекочитаемый список `evidence/`.
 * @param {{files: Array<{path: string, bytes: number}>, truncated: boolean, error: string | null}} listing
 *   результат {@link listEvidence}
 * @returns {string} текст для `ui.notify`
 */
export declare function describeEvidence(listing: {
    files: Array<{
        path: string;
        bytes: number;
    }>;
    truncated: boolean;
    error: string | null;
}): string;
/**
 * Содержимое файла `evidence/` по явному запросу: только чтение и только начало файла.
 * @param {string} dir каталог цикла
 * @param {string} name путь относительно `evidence/`
 * @returns {{path: string, text: string, truncated: boolean, size: number, error: string | null}}
 *   содержимое: путь, начало файла, признак обрезки, полный размер и текст ошибки
 */
export declare function readEvidenceFile(dir: string, name: string): {
    path: string;
    text: string;
    truncated: boolean;
    size: number;
    error: string | null;
};
/**
 * Человекочитаемый файл `evidence/` с честной пометкой об обрезке.
 * @param {{path: string, text: string, truncated: boolean, size: number, error: string | null}} file
 *   результат {@link readEvidenceFile}
 * @returns {string} текст для `ui.notify`
 */
export declare function describeEvidenceFile(file: {
    path: string;
    text: string;
    truncated: boolean;
    size: number;
    error: string | null;
}): string;
