/**
 * The longest delay a timer takes: `setTimeout` keeps its delay in an
 * int32, so one past about 24.8 days overflows and fires at once. A longer
 * timeout is refused instead.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;
