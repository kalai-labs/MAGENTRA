// @ts-check
/**
 * Print messages to the terminal.
 *
 * Colour is off when the output is not a terminal, and when the `NO_COLOR`
 * variable is set. Therefore the output of a CI job stays readable.
 */

const useColour =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

/**
 * @param {string} code
 * @returns {(text: string) => string}
 */
const paint = (code) => (text) => (useColour ? `\x1b[${code}m${text}\x1b[0m` : text);

export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

/** @param {string} [text] */
export const info = (text = '') => console.log(text);

/** @param {string} text */
export const success = (text) => console.log(`${green('✓')} ${text}`);

/** @param {string} text */
export const warn = (text) => console.log(`${yellow('!')} ${text}`);

/** @param {string} text */
export const error = (text) => console.error(`${red('✗')} ${text}`);

/** @param {string} text */
export const heading = (text) => console.log(`\n${bold(text)}`);
