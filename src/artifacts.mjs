/**
 * Артефакты цикла: чтение и человекочитаемый вид (issue #4).
 *
 * Контракт (ADR 0004/0008 ядра): адаптер вызывает `bin` ядра и читает файлы `.pi/artifacts/**`.
 * Модуль поэтому только читает: ни одного вызова записи — управление стадиями остаётся за CLI
 * (`cycle-state`), а `evidence/` — вход оценщика, а не второй редактор (ADR 0006 ядра).
 *
 * Схемы — Приложение A `docs/orchestrator-core.md` ядра: `state.json`, `gates.<n>.json`,
 * `decision.<n>.json`, каталог `evidence/`. Битый или отсутствующий файл даёт текст ошибки, а не
 * исключение: причина отказа цикла чаще всего видна именно в недописанном артефакте, и падать на
 * нём — значит закрыть человеку ровно тот разбор, за которым он пришёл.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Состояние цикла — единственный писатель `cycle-state` (§5.3). */
export const STATE_FILE = 'state.json';

/** Логи гейтов: `gates/<id>.<n>.log` (§5.5). */
export const GATES_LOGS_DIR = 'gates';

/** Каталог пакета оценщика (§5.4). */
export const EVIDENCE_DIR = 'evidence';

/** Сколько первых строк лога гейта печатаем (полный вывод — простыня в TUI). */
export const MAX_GATE_LOG_LINES = 5;

/** Потолок одной строки лога: строки бывают «одной строкой на весь отчёт». */
export const MAX_GATE_LOG_CHARS = 200;

/** Сколько символов логов гейтов печатаем на всю итерацию. */
export const MAX_GATE_LOG_TOTAL_CHARS = 1200;

/** Сколько байт файла `evidence/` показываем по явному запросу. */
export const MAX_EVIDENCE_BYTES = 32 * 1024;

/** Сколько строк файла `evidence/` показываем по явному запросу. */
export const MAX_EVIDENCE_LINES = 200;

/** Сколько файлов `evidence/` перечисляем: пакет растёт от итерации к итерации. */
export const MAX_EVIDENCE_ENTRIES = 200;

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
export function iterationFileName(kind, iteration) {
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error(`номер итерации должен быть целым ≥ 1, получено: ${iteration}`);
  }

  return `${kind}.${iteration}.json`;
}

/**
 * Номер итерации из аргумента команды: пусто — «текущая», не число — ошибка текстом.
 * @param {string | undefined} text аргумент `[n]`
 * @returns {{iteration: number | null, error: string | null}} номер или текст ошибки
 */
export function parseIteration(text) {
  const raw = (text ?? '').trim();
  if (raw === '') return { iteration: null, error: null };

  const shown = JSON.stringify(raw);
  if (!/^\d+$/u.test(raw)) {
    return { iteration: null, error: `номер итерации: ожидается целое ≥ 1, получено ${shown}` };
  }

  const value = Number(raw);
  if (value < 1) {
    return { iteration: null, error: `номер итерации: ожидается целое ≥ 1, получено ${shown}` };
  }

  return { iteration: value, error: null };
}

/**
 * Каталог цикла из ответа драйвера: абсолютный путь берётся как есть, относительный — от корня.
 * @param {{root: string, dir: unknown}} params корень проекта и `cycle.dir`
 * @returns {string | null} каталог или `null`, если драйвер пути не дал
 */
export function resolveCycleDir({ root, dir }) {
  if (typeof dir !== 'string' || dir.trim() === '') return null;

  return isAbsolute(dir) ? dir : resolve(root, dir);
}

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
export function findCycleDir(root) {
  const artifactsDir = join(root, '.pi', 'artifacts');
  /** @type {import('node:fs').Dirent[]} */
  let entries = [];
  try {
    entries = readdirSync(artifactsDir, { withFileTypes: true });
  } catch {
    return { dir: null, error: 'каталога `.pi/artifacts/` нет: цикл в этом проекте не начинался' };
  }

  const found = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(artifactsDir, entry.name))
    .filter((candidate) => existsSync(join(candidate, STATE_FILE)));

  if (found.length === 0) {
    return { dir: null, error: 'в `.pi/artifacts/` нет ни одного каталога со `state.json`' };
  }
  if (found.length > 1) {
    const names = found.map((path) => basename(path)).join(', ');
    return {
      dir: null,
      error:
        `в \`.pi/artifacts/\` несколько каталогов цикла (${names}): какой из них показывать, ` +
        'адаптер не угадывает — запустите команду в проекте с одним активным циклом',
    };
  }

  const [only] = found;
  if (only === undefined) {
    return { dir: null, error: 'каталог цикла не найден' };
  }

  return { dir: only, error: null };
}

/**
 * Разбор JSON-артефакта каталога цикла.
 *
 * Содержимое файла в текст ошибки не попадает (правило «секреты не печатаем»): только имя файла
 * и что с ним не так.
 * @param {string} dir каталог цикла
 * @param {string} file имя файла внутри каталога
 * @returns {Artifact} значение и ошибка
 */
export function readArtifact(dir, file) {
  const path = join(dir, file);
  if (!existsSync(path)) return { value: null, error: `нет файла ${file}` };

  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch {
    return {
      value: null,
      error: `файл ${file} не разобран как JSON: писатель мог оборваться на середине`,
    };
  }
}

/**
 * Номер итерации из разобранного `state.json` — по умолчанию для `gates`/`decision`.
 * @param {unknown} state разобранный `state.json`
 * @returns {number | null} итерация или `null`, если поля нет
 */
export function artifactIteration(state) {
  const record = asRecord(state);
  const iteration = record === null ? null : asNumber(record.iteration);

  return iteration !== null && Number.isInteger(iteration) && iteration >= 1 ? iteration : null;
}

/**
 * Первые строки лога гейта: `gates/<id>.<n>.log` (§5.5 ядра).
 *
 * Читается только начало файла: логи ядра маскируются при захвате, но печатать целиком их всё
 * равно нельзя — это простыни, в которых человек не найдёт строку отказа.
 * @param {string} dir каталог цикла
 * @param {string} logPath путь лога из `gates.<n>.json` (относительный)
 * @returns {{lines: string[], error: string | null}} первые строки или текст ошибки
 */
export function gateLogHead(dir, logPath) {
  const path = insideCycle(dir, logPath);
  if (path === null) return { lines: [], error: `лог ${logPath}: путь вне каталога цикла` };
  if (!existsSync(path)) return { lines: [], error: `лог ${logPath} не найден` };

  const head = readHead(path, MAX_GATE_LOG_LINES * (MAX_GATE_LOG_CHARS + 1));
  const lines = head
    .split(/\r?\n/u)
    .slice(0, MAX_GATE_LOG_LINES)
    .map((line) =>
      line.length > MAX_GATE_LOG_CHARS ? `${line.slice(0, MAX_GATE_LOG_CHARS)}…` : line,
    )
    .filter((line) => line.trim() !== '');

  return { lines, error: null };
}

/**
 * Человекочитаемый `state.json`: стадия, шаг, итерация, чего цикл ждёт.
 * @param {unknown} value разобранный `state.json`
 * @returns {string} текст для `ui.notify`
 */
export function describeState(value) {
  const state = asRecord(value);
  if (state === null) return 'state.json: ожидался объект состояния';

  const stage = asString(state.stage) ?? '?';
  const status = asString(state.stage_status) ?? '?';
  const iteration = asNumber(state.iteration);
  const maxIterations = asNumber(state.max_iterations);
  const limit = maxIterations === null ? '' : ` из ${maxIterations}`;
  const lines = [`Стадия ${stage} (${status}) · итерация ${iteration ?? '?'}${limit}`];

  /** @type {string[]} */
  const identity = [];
  const issue = asNumber(state.issue);
  if (issue !== null) identity.push(`issue #${issue}`);
  const slug = asString(state.slug);
  if (slug !== null && slug !== '') identity.push(slug);
  const branch = asString(state.branch);
  if (branch !== null && branch !== '') identity.push(`ветка ${branch}`);
  if (identity.length > 0) lines.push(identity.join(' · '));

  const digest = asString(state.criteria_sha256);
  lines.push(
    digest === null ? 'Критерии: не заморожены' : `Критерии: заморожены (${digest.slice(0, 8)}…)`,
  );

  const history = asArray(state.history)
    .map((entry) => asRecord(entry))
    .filter((entry) => entry !== null);
  const open = [...history].reverse().find((entry) => entry.finished_at === null);
  const closed = [...history].reverse().find((entry) => entry.finished_at !== null);
  if (closed !== undefined) {
    lines.push(
      `Закрыт последним: ${asString(closed.stage) ?? '?'} ${asString(closed.status) ?? '?'} ` +
        `(${asString(closed.finished_at) ?? '?'})`,
    );
  }

  const escalation = asRecord(state.escalation);
  if (escalation !== null) {
    const reason = asString(escalation.reason) ?? '?';
    const detail = asString(escalation.detail) ?? 'без деталей';
    lines.push(`Ждём: решения владельца — эскалация ${reason}: ${detail}`);
  } else if (open !== undefined) {
    lines.push(
      `Ждём: завершения ${asString(open.stage) ?? '?'} — этап открыт с ` +
        `${asString(open.started_at) ?? '?'}`,
    );
  } else {
    lines.push('Ждём: следующего шага — открытых этапов нет');
  }

  const retries = asRecord(state.retries);
  if (retries !== null) {
    const shown = ['REVIEW', 'EVALUATE', 'evidence']
      .map((key) => `${key} ${asNumber(retries[key]) ?? 0}`)
      .join(' · ');
    lines.push(`Повторы: ${shown}`);
  }

  if (state.owner_approved === true) lines.push('Подтверждение владельца: да');

  const applied = asRecord(state.applied_decision);
  if (applied !== null) {
    const appliedIteration = asNumber(applied.iteration);
    lines.push(
      `Применено решение: ${asString(applied.action) ?? '?'}` +
        `${appliedIteration === null ? '' : ` (итерация ${appliedIteration})`}`,
    );
  }

  return lines.join('\n');
}

/**
 * Человекочитаемые гейты итерации: что прошло, что нет, код возврата, первые строки лога.
 * @param {string} dir каталог цикла (для логов `gates/<id>.<n>.log`)
 * @param {unknown} value разобранный `gates.<n>.json`
 * @returns {string} текст для `ui.notify`
 */
export function describeGates(dir, value) {
  const payload = asRecord(value);
  if (payload === null) return 'gates.<n>.json: ожидался объект с полем gates';

  const gates = asArray(payload.gates)
    .map((gate) => asRecord(gate))
    .filter((gate) => gate !== null);
  if (gates.length === 0) {
    return 'Гейты: в файле нет списка gates — гейты этой итерации не запускались';
  }

  /** @type {Record<string, number>} */
  const counts = { pass: 0, fail: 0, skipped: 0, not_run: 0 };
  for (const gate of gates) {
    const status = asString(gate.status);
    if (status !== null && status in counts) counts[status] = (counts[status] ?? 0) + 1;
  }

  const iteration = asNumber(payload.iteration);
  const head = shortSha(payload.head);
  const lines = [
    `Гейты итерации ${iteration ?? '?'}: pass ${counts.pass} · fail ${counts.fail} · ` +
      `skipped ${counts.skipped} · not_run ${counts.not_run}${head === null ? '' : ` · head ${head}`}`,
  ];

  let budget = MAX_GATE_LOG_TOTAL_CHARS;
  for (const gate of gates) {
    const status = asString(gate.status) ?? '?';
    lines.push(describeGate(gate, status));
    if (status !== 'fail') continue;

    const logPath = asString(gate.log);
    if (logPath === null) continue;

    const logHead = gateLogHead(dir, logPath);
    if (logHead.error !== null) {
      lines.push(`  ${logHead.error}`);
      continue;
    }
    if (logHead.lines.length === 0) continue;

    lines.push('  первые строки вывода:');
    for (const line of logHead.lines) {
      if (budget <= 0) {
        lines.push('  │ …');
        break;
      }
      budget -= line.length;
      lines.push(`  │ ${line}`);
    }
  }

  return lines.join('\n');
}

/**
 * Человекочитаемое решение итерации: действие, причина, куда возврат.
 * @param {unknown} value разобранный `decision.<n>.json`
 * @returns {string} текст для `ui.notify`
 */
export function describeDecision(value) {
  const decision = asRecord(value);
  if (decision === null) return 'decision.<n>.json: ожидался объект решения';

  const action = asString(decision.action);
  if (action === null) return 'decision.<n>.json: нет поля action — решение не записано';

  const iteration = asNumber(decision.iteration);
  const retry = asString(decision.retry_stage);
  const lines = [
    `Решение итерации ${iteration ?? '?'}: ${action}${retry === null ? '' : ` → повтор ${retry}`}`,
  ];

  const reasons = strings(decision.reasons);
  if (reasons.length > 0) lines.push(`Причины: ${reasons.join(', ')}`);

  const acquire = strings(decision.acquire);
  if (acquire.length > 0) lines.push(`Добор свидетельств: ${acquire.join(', ')}`);

  const rework = strings(decision.rework_items);
  if (rework.length > 0) lines.push(`На доработку: ${rework.join(', ')}`);

  const downgraded = strings(decision.downgraded);
  if (downgraded.length > 0) lines.push(`Понижено: ${downgraded.join(', ')}`);

  const unverified = strings(decision.unverified);
  if (unverified.length > 0) lines.push(`Не подтверждено: ${unverified.join(', ')}`);

  const unresolved = asNumber(asRecord(decision.counts)?.['unresolved_refs']);
  if (unresolved !== null) lines.push(`Неразрешённых ссылок: ${unresolved}`);

  return lines.join('\n');
}

/**
 * Список файлов `evidence/` с размерами: что ушло оценщику.
 * @param {string} dir каталог цикла
 * @returns {{files: Array<{path: string, bytes: number}>, truncated: boolean, error: string | null}}
 *   файлы (пути относительно `evidence/`), признак обрезки списка и текст ошибки
 */
export function listEvidence(dir) {
  const evidenceDir = join(dir, EVIDENCE_DIR);
  if (!existsSync(evidenceDir)) {
    return { files: [], truncated: false, error: `каталога ${EVIDENCE_DIR}/ нет` };
  }

  /** @type {Array<{path: string, bytes: number}>} */
  const files = [];
  let truncated = false;

  /**
   * @param {string} absolute каталог на диске
   * @param {string} prefix путь относительно `evidence/`
   * @returns {void}
   */
  const walk = (absolute, prefix) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= MAX_EVIDENCE_ENTRIES) {
        truncated = true;
        return;
      }

      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(full, path);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        files.push({ path, bytes: statSync(full).size });
      } catch {
        // Файл исчез между чтением каталога и `stat`: показывать его нечем, остальное важно.
      }
    }
  };

  walk(evidenceDir, '');

  return { files, truncated, error: null };
}

/**
 * Человекочитаемый список `evidence/`.
 * @param {{files: Array<{path: string, bytes: number}>, truncated: boolean, error: string | null}} listing
 *   результат {@link listEvidence}
 * @returns {string} текст для `ui.notify`
 */
export function describeEvidence(listing) {
  if (listing.error !== null) return `${EVIDENCE_DIR}/: ${listing.error}`;
  if (listing.files.length === 0) {
    return `Пакет ${EVIDENCE_DIR}/ пуст: оценщику ещё нечего показывать`;
  }

  const total = listing.files.reduce((sum, file) => sum + file.bytes, 0);
  const lines = [
    `Пакет ${EVIDENCE_DIR}/: ${listing.files.length} файл(ов), ${formatBytes(total)}`,
    ...listing.files.map((file) => `  ${file.path} · ${formatBytes(file.bytes)}`),
  ];
  if (listing.truncated) {
    lines.push(`  …файлов больше ${MAX_EVIDENCE_ENTRIES}: список обрезан`);
  }
  lines.push(`Показать файл: /cycle ${EVIDENCE_DIR} <путь>`);

  return lines.join('\n');
}

/**
 * Содержимое файла `evidence/` по явному запросу: только чтение и только начало файла.
 * @param {string} dir каталог цикла
 * @param {string} name путь относительно `evidence/`
 * @returns {{path: string, text: string, truncated: boolean, size: number, error: string | null}}
 *   содержимое: путь, начало файла, признак обрезки, полный размер и текст ошибки
 */
export function readEvidenceFile(dir, name) {
  const base = join(dir, EVIDENCE_DIR);
  const path = insideCycle(base, name);
  if (path === null) {
    return {
      path: name,
      text: '',
      truncated: false,
      size: 0,
      error: 'путь вне каталога evidence/',
    };
  }
  if (!existsSync(path)) {
    return { path: name, text: '', truncated: false, size: 0, error: 'файла нет' };
  }

  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { path: name, text: '', truncated: false, size: 0, error: 'файл не читается' };
  }

  const head = readHead(path, MAX_EVIDENCE_BYTES);
  const allLines = head.split(/\r?\n/u);
  const lines = allLines.slice(0, MAX_EVIDENCE_LINES);
  const truncated = size > MAX_EVIDENCE_BYTES || allLines.length > MAX_EVIDENCE_LINES;

  return { path: name, text: lines.join('\n'), truncated, size, error: null };
}

/**
 * Человекочитаемый файл `evidence/` с честной пометкой об обрезке.
 * @param {{path: string, text: string, truncated: boolean, size: number, error: string | null}} file
 *   результат {@link readEvidenceFile}
 * @returns {string} текст для `ui.notify`
 */
export function describeEvidenceFile(file) {
  if (file.error !== null) return `${EVIDENCE_DIR}/${file.path}: ${file.error}`;

  const size = formatBytes(file.size);
  const header = `Файл ${EVIDENCE_DIR}/${file.path}${size === '' ? '' : ` (${size})`}`;
  const note = file.truncated
    ? `Показано начало: ${MAX_EVIDENCE_LINES} строк / ${formatBytes(MAX_EVIDENCE_BYTES)}. Полный файл — в каталоге цикла.`
    : null;

  return [
    header,
    file.text === '' ? '(файл пуст)' : file.text,
    ...(note === null ? [] : [note]),
  ].join('\n');
}

/**
 * Путь внутри каталога: артефакт мог быть правлен руками, поэтому выход наружу запрещён.
 * @param {string} base базовый каталог
 * @param {string} path путь из артефакта или аргумента команды
 * @returns {string | null} абсолютный путь или `null`, если он вне `base`
 */
function insideCycle(base, path) {
  if (path.trim() === '' || isAbsolute(path)) return null;

  const root = resolve(base);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;

  return target;
}

/**
 * Начало файла: читаем ограниченный кусок, а не весь лог (`до 5 МБ` у гейтов, §5.5).
 * @param {string} path файл
 * @param {number} bytes сколько байт прочитать
 * @returns {string} текст начала файла
 */
function readHead(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Одна запись гейта: статус, обязательность, код возврата, длительность.
 * @param {Record<string, unknown>} gate запись гейта
 * @param {string} status статус гейта
 * @returns {string} строка
 */
function describeGate(gate, status) {
  const parts = [`${status} ${asString(gate.id) ?? '?'}`];
  if (gate.required === true) parts.push('required');

  const exit = asNumber(gate.exit);
  if (exit !== null) parts.push(`код ${exit}`);

  const duration = asNumber(gate.duration_s);
  if (duration !== null && duration > 0) parts.push(`${duration}s`);

  const reason = asString(gate.reason);
  if (reason !== null && reason !== '') parts.push(`причина ${reason}`);

  const log = asString(gate.log);
  if (log !== null && status !== 'pass') parts.push(`лог ${log}`);

  return parts.join(' · ');
}

/**
 * Короткий `sha` для заголовка: полный хеш в шапке читать незачем.
 * @param {unknown} value `head` или `base_sha`
 * @returns {string | null} первые 7 символов или `null`
 */
function shortSha(value) {
  const sha = typeof value === 'string' ? value.trim() : '';

  return /^[0-9a-f]{7,}/u.test(sha) ? sha.slice(0, 7) : null;
}

/**
 * Массив строк из `decision.<n>.json`: не-строки пропускаются, а не превращаются в «object».
 * @param {unknown} value значение поля
 * @returns {string[]} строки
 */
function strings(value) {
  return asArray(value)
    .filter((item) => typeof item === 'string' && item !== '')
    .map((item) => String(item));
}

/**
 * Размер для человека.
 * @param {number} bytes байты
 * @returns {string} строка вида `1.2 КБ`
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * Объект без массива — иначе `null`: у артефактов проверять поля безопаснее, чем верить схеме.
 * @param {unknown} value значение
 * @returns {Record<string, unknown> | null} запись или `null`
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * Массив или пустой список.
 * @param {unknown} value значение
 * @returns {unknown[]} массив
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Строка или `null`.
 * @param {unknown} value значение
 * @returns {string | null} строка
 */
function asString(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * Конечное число или `null`.
 * @param {unknown} value значение
 * @returns {number | null} число
 */
function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
