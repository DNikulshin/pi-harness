/**
 * Запуск ядра и разбор его ответа: `harness-cycle-driver next|run`.
 *
 * Контракт (`docs/orchestrator-core.md` §5.3a ядра, `cycle-driver.next/1`): вывод — всегда JSON,
 * поля шага на верхнем уровне (`action`, `step`, `target`, `commands`, `waiting_for`), рядом
 * `cycle` (итерация, ветка, подтверждение, эскалация) и `done` (история и счётчики журнала).
 * Версия формы — `contract`: на чужой ревизии адаптер обязан отказать, а не угадывать (§5.3a,
 * «правило совместимости»).
 *
 * Обращение к ядру — `bin` в `node_modules/.bin` проекта: ни импортов, ни чтения `scripts/**`
 * (ADR 0004/0008 ядра). Запускаем через `node <bin>`, а не через shim напрямую: так не нужен бит
 * исполнения, и одинаково работает на linux и darwin.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Уровень уведомления Pi: тот же набор, что в `ctx.ui.notify`. */
/** @typedef {'info' | 'warning' | 'error'} NotifyLevel */

/** Версия формы ответа драйвера, которую понимает адаптер. */
export const SUPPORTED_CONTRACT = 'cycle-driver.next/1';

/** Действия, которые драйвер исполняет без человека. */
export const EXECUTABLE_ACTIONS = Object.freeze(new Set(['run', 'advance', 'finish']));

/** Действия, на которых адаптер останавливается: работу делает человек или другая сессия. */
export const STOP_ACTIONS = Object.freeze(new Set(['spawn', 'handoff', 'stop', 'blocked']));

/** Стадии, вход в которые требует подтверждения владельца (#3). */
export const CONFIRM_TARGETS = Object.freeze(new Set(['PR', 'ESCALATED']));

/** Имя `bin` драйвера в пакете ядра. */
export const DRIVER_BIN = 'harness-cycle-driver';

/** Сколько шагов адаптер исполняет за один `/cycle run`; дальше — новый вопрос человеку. */
export const MAX_STEPS_PER_RUN = 10;

/**
 * Путь к `bin` драйвера в проекте.
 * @param {string} root корень проекта
 * @returns {string | null} путь или `null`, если ядро не установлено
 */
export function driverPath(root) {
  const file = join(root, 'node_modules', '.bin', DRIVER_BIN);
  return existsSync(file) ? file : null;
}

/**
 * Ответ драйвера.
 * @typedef {object} DriverResult
 * @property {number} code код возврата (0 — шаг определён или исполнен, 1 — `blocked`/остановка,
 *   2 — ошибка использования или данных, 3/4 — коды подпроцессов ядра)
 * @property {unknown} json разобранный JSON ответа (`null`, если тело не JSON)
 * @property {string} stderr текст ошибки драйвера (или `stderr` процесса)
 */

/**
 * Запуск подкоманды драйвера.
 * @param {{root: string, args: string[]}} params корень проекта и аргументы после подкоманды
 * @returns {Promise<DriverResult>} код и разобранный ответ
 */
export async function callDriver({ root, args }) {
  const bin = driverPath(root);
  if (bin === null) {
    throw new Error(
      `bin ${DRIVER_BIN} не найден в ${join(root, 'node_modules', '.bin')}: ` +
        'установлено ли ядро (@dnikulshin/harness)?',
    );
  }

  const common = ['--root', root];
  try {
    const { stdout } = await execFileAsync(process.execPath, [bin, ...args, ...common], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, json: parseJson(stdout), stderr: '' };
  } catch (error) {
    const failed = /** @type {{code?: number, stdout?: string, stderr?: string}} */ (error);
    const stdout = failed.stdout ?? '';
    return {
      code: typeof failed.code === 'number' ? failed.code : 2,
      json: parseJson(stdout),
      stderr: (failed.stderr ?? '').trim(),
    };
  }
}

/**
 * JSON из вывода драйвера.
 * @param {string} text вывод
 * @returns {unknown} разобранный объект или `null`
 */
function parseJson(text) {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * План шага из ответа `next`.
 * @typedef {object} StepPlan
 * @property {string} contract версия формы
 * @property {string} action `run` | `advance` | `finish` | `spawn` | `handoff` | `stop` | `blocked`
 * @property {string | null} step токен детерминированного скрипта
 * @property {string} stage стадия
 * @property {string} status статус стадии
 * @property {string | null} target стадия перехода
 * @property {string} reason причина решения
 * @property {string | null} waitingFor чего ждёт цикл
 * @property {string[]} commands готовые команды
 * @property {string | null} cycleDir каталог цикла из `cycle.dir` — по нему читаются артефакты
 * @property {object | null} cycle блок `cycle` (итерация, ветка, подтверждение, эскалация)
 * @property {object | null} done блок `done` (история и счётчики журнала)
 */

/**
 * Разбор и проверка ответа `next` против контракта.
 * @param {unknown} json разобранный ответ
 * @returns {StepPlan} план шага
 * @throws {Error} если ответ не по контракту или версия формы чужая
 */
export function parseStepPlan(json) {
  if (json === null || typeof json !== 'object') {
    throw new Error(
      'драйвер вернул не JSON: ожидается объект с полями шага (contract cycle-driver.next/1)',
    );
  }

  /** @type {Record<string, unknown>} */
  const plan = /** @type {Record<string, unknown>} */ (json);
  const contract = typeof plan.contract === 'string' ? plan.contract : '(нет поля contract)';
  if (contract !== SUPPORTED_CONTRACT) {
    throw new Error(
      `контракт драйвера ${contract} не поддержан: адаптер понимает ${SUPPORTED_CONTRACT}. ` +
        'Обновите адаптер или поставьте совместимую версию ядра.',
    );
  }

  const action = typeof plan.action === 'string' ? plan.action : null;
  if (action === null) throw new Error('в ответе драйвера нет поля action');
  if (!EXECUTABLE_ACTIONS.has(action) && !STOP_ACTIONS.has(action)) {
    throw new Error(`неизвестное действие драйвера: ${action}`);
  }

  return {
    contract,
    action,
    step: typeof plan.step === 'string' ? plan.step : null,
    stage: typeof plan.stage === 'string' ? plan.stage : '?',
    status: typeof plan.status === 'string' ? plan.status : '?',
    target: typeof plan.target === 'string' ? plan.target : null,
    reason: typeof plan.reason === 'string' ? plan.reason : '',
    waitingFor: typeof plan.waiting_for === 'string' ? plan.waiting_for : null,
    commands: Array.isArray(plan.commands)
      ? plan.commands.filter((c) => typeof c === 'string')
      : [],
    cycleDir: cycleDirOf(plan.cycle),
    cycle:
      plan.cycle !== null && typeof plan.cycle === 'object'
        ? /** @type {object} */ (plan.cycle)
        : null,
    done:
      plan.done !== null && typeof plan.done === 'object'
        ? /** @type {object} */ (plan.done)
        : null,
  };
}

/**
 * Каталог цикла из блока `cycle` (§5.3a ядра): адаптер читает по нему артефакты, а не ищет
 * каталоги сам — правила активности каталогов живут в ядре.
 * @param {unknown} cycle блок `cycle` ответа драйвера
 * @returns {string | null} путь из `cycle.dir` или `null`, если поля нет
 */
function cycleDirOf(cycle) {
  if (cycle === null || typeof cycle !== 'object') return null;

  const dir = /** @type {Record<string, unknown>} */ (cycle).dir;

  return typeof dir === 'string' && dir !== '' ? dir : null;
}

/**
 * Нужно ли подтверждение владельца перед исполнением шага.
 *
 * Подтверждение нужно на входе в `PR` и `ESCALATED` (issue #3): это переходы, после которых
 * работа уходит человеку или проект получает эскалацию, и отменить их из адаптера нечем.
 * `blocked` — не переход, а остановка: она показывается, но не подтверждается.
 * @param {StepPlan} plan план шага
 * @returns {boolean} `true`, если спрашивать владельца
 */
export function needsConfirmation(plan) {
  if (plan.action === 'blocked') return false;
  if (plan.target !== null && CONFIRM_TARGETS.has(plan.target)) return true;

  // Эскалация в состоянии цикла: даже если шаг ведёт в ту же стадию, решение уже принято человеком.
  return plan.cycle !== null && 'escalation' in plan.cycle && plan.cycle.escalation !== null;
}

/**
 * Человекочитаемый вид плана шага для `/cycle next`.
 * @param {StepPlan} plan план шага
 * @returns {string} текст для `ui.notify`
 */
export function describePlan(plan) {
  const lines = [`Стадия ${plan.stage} (${plan.status}) · шаг ${plan.step ?? '—'}`];
  lines.push(`Действие: ${plan.action}${plan.target === null ? '' : ` → ${plan.target}`}`);
  if (plan.reason !== '') lines.push(`Причина: ${plan.reason}`);
  if (plan.waitingFor !== null) lines.push(`Ждём: ${plan.waitingFor}`);

  const cycle =
    /** @type {{iteration?: number, max_iterations?: number|null, branch?: string}|null} */ (
      plan.cycle
    );
  if (cycle !== null && typeof cycle.iteration === 'number') {
    const limit = typeof cycle.max_iterations === 'number' ? ` из ${cycle.max_iterations}` : '';
    lines.push(
      `Итерация ${cycle.iteration}${limit}${cycle.branch ? ` · ветка ${cycle.branch}` : ''}`,
    );
  }

  const done = /** @type {{stages?: Array<{stage?: string, status?: string}>}|null} */ (plan.done);
  if (done !== null && Array.isArray(done.stages) && done.stages.length > 0) {
    const recent = done.stages
      .slice(-3)
      .map((entry) => `${entry.stage ?? '?'}:${entry.status ?? '?'}`)
      .join(', ');
    lines.push(`Сделано: ${recent}`);
  }

  if (plan.commands.length > 0 && plan.action !== 'blocked') {
    lines.push(`Команда: ${plan.commands.join(' && ')}`);
  }

  return lines.join('\n');
}
