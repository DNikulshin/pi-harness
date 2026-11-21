/**
 * `/cycle run`: исполнение детерминированных шагов с остановками и подтверждениями.
 *
 * Шаги исполняет ядро (`cycle-driver run --max-steps 1`), адаптер только спрашивает разрешение
 * и решает, продолжать ли. Своя арифметика переходов здесь была бы второй копией автомата ядра,
 * поэтому её нет: каждый шаг — отдельный вызов драйвера, а не один длинный `run`.
 *
 * Почему по шагу, а не один `run` целиком: подтверждение на входе в `PR`/`ESCALATED` нужно
 * **до** исполнения перехода. Внутри одного `run` границу не вставить, поэтому адаптер идёт по
 * шагам и между ними спрашивает владельца.
 */
import {
  MAX_STEPS_PER_RUN,
  STOP_ACTIONS,
  describePlan,
  needsConfirmation,
  parseStepPlan,
} from './driver.mjs';

/**
 * Что вернул `run --max-steps 1`.
 * @typedef {object} RunOutcome
 * @property {number} executed сколько команд исполнено
 * @property {{command: string, code: number} | null} failed первая упавшая команда
 * @property {string | null} error текст отказа драйвера
 * @property {import('./driver.mjs').StepPlan | null} stop план остановки (если драйвер упёрся в неисполняемый шаг)
 * @property {number} code код возврата процесса
 */

/**
 * Разбор ответа `run`.
 *
 * Тонкость: при `--max-steps 1` драйвер сначала исполняет шаг, потом упирается в собственный лимит
 * и возвращает `{executed:[…], error:'лимит шагов'}` с кодом 1. Это не отказ, а признак «шаг
 * сделан»: различаем по непустому `executed` и по отсутствию упавшей команды.
 * @param {unknown} json разобранный JSON
 * @param {number} code код возврата
 * @returns {RunOutcome} итог шага
 */
export function parseRunOutcome(json, code) {
  /** @type {RunOutcome} */
  const outcome = { executed: 0, failed: null, error: null, stop: null, code };

  if (json === null || typeof json !== 'object') {
    outcome.error = 'драйвер вернул не JSON о исполнении шага';
    return outcome;
  }

  /** @type {Record<string, unknown>} */
  const raw = /** @type {Record<string, unknown>} */ (json);
  const executed = Array.isArray(raw.executed) ? raw.executed : [];
  outcome.executed = executed.length;

  for (const entry of executed) {
    const failed = /** @type {{command?: unknown, code?: unknown}} */ (entry);
    if (typeof failed.code === 'number' && failed.code !== 0) {
      outcome.failed = {
        command: typeof failed.command === 'string' ? failed.command : '(команда не названа)',
        code: failed.code,
      };
      break;
    }
  }

  if (typeof raw.error === 'string') outcome.error = raw.error;

  if (raw.next !== null && raw.next !== undefined) {
    try {
      outcome.stop = parseStepPlan(raw.next);
    } catch {
      // Ответ `next` внутри `run` не по контракту — покажем как отказ ниже, а не проглотим.
      outcome.error ??= 'ответ драйвера о следующем шаге не по контракту';
    }
  }

  return outcome;
}

/**
 * Зависимости прогона — подставляются в тестах.
 * @typedef {object} RunDeps
 * @property {() => Promise<{json: unknown, code: number}>} next получить план шага
 * @property {() => Promise<{json: unknown, code: number}>} runOne исполнить один шаг
 * @property {(text: string) => Promise<boolean>} confirm спросить владельца
 * @property {(text: string, level: import('./driver.mjs').NotifyLevel) => void} notify показать текст
 * @property {number} [maxSteps] предел шагов за один вызов
 */

/**
 * Итог `/cycle run`.
 * @typedef {object} RunReport
 * @property {number} steps сколько шагов исполнено
 * @property {string} stopped на чём остановились: `done` | `spawn` | `handoff` | `stop` |
 *   `blocked` | `declined` | `failed` | `limit`
 * @property {import('./driver.mjs').StepPlan | null} plan последний увиденный план
 */

/**
 * Прогон цикла: шаг — подтверждение — исполнение, до остановки.
 * @param {RunDeps} deps зависимости
 * @returns {Promise<RunReport>} итог
 */
export async function runCycle(deps) {
  const maxSteps = deps.maxSteps ?? MAX_STEPS_PER_RUN;
  /** @type {import('./driver.mjs').StepPlan | null} */
  let plan = null;
  let steps = 0;

  for (let index = 0; index < maxSteps; index += 1) {
    const nextResult = await deps.next();
    try {
      plan = parseStepPlan(nextResult.json);
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
      return { steps, stopped: 'failed', plan };
    }

    if (STOP_ACTIONS.has(plan.action)) {
      deps.notify(describePlan(plan), plan.action === 'blocked' ? 'error' : 'info');
      return { steps, stopped: plan.action, plan };
    }

    if (needsConfirmation(plan)) {
      const confirmed = await deps.confirm(
        `Переход ${plan.stage} → ${plan.target ?? plan.stage} (${plan.reason}). Продолжить?`,
      );
      if (!confirmed) {
        deps.notify(
          `Отменено владельцем: цикл остался на стадии ${plan.stage}, ничего не исполнено.`,
          'warning',
        );
        return { steps, stopped: 'declined', plan };
      }
    }

    const runResult = await deps.runOne();
    const outcome = parseRunOutcome(runResult.json, runResult.code);
    if (outcome.failed !== null) {
      deps.notify(
        `Шаг ${plan.step ?? plan.action} упал: команда ${outcome.failed.command} вернула код ${outcome.failed.code}.`,
        'error',
      );
      return { steps, stopped: 'failed', plan };
    }

    if (outcome.executed === 0) {
      // Ничего не исполнено и упавшей команды нет: драйвер отказал до работы.
      deps.notify(
        outcome.error ??
          `Драйвер не исполнил шаг ${plan.step ?? plan.action} (код ${outcome.code}).`,
        'error',
      );
      return { steps, stopped: 'failed', plan };
    }

    steps += 1;
  }

  deps.notify(`Исполнено ${steps} шагов — предел за один вызов. Повторите /cycle run.`, 'warning');
  return { steps, stopped: 'limit', plan };
}
