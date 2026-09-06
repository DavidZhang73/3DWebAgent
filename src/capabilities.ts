import Ajv from 'ajv';
import type { Input, ToolName, CommandName } from './types.ts';
import definitions from '../schema/tools.json' with { type: 'json' };
import internal from '../schema/commands.json' with { type: 'json' };
export const DEFINITIONS = definitions as Record<
  ToolName,
  { description: string; inputSchema: object; readOnly: boolean }
>;
const ajv = new Ajv({ strict: false });
const validators = Object.fromEntries(
  Object.entries({ ...DEFINITIONS, ...internal }).map(([name, definition]) => [
    name,
    ajv.compile(definition.inputSchema),
  ]),
);
export function validateInput(name: CommandName, input: Input) {
  const validate = validators[name];
  if (!validate || !validate(input))
    throw new Error('Invalid ' + name + ' arguments: ' + ajv.errorsText(validate?.errors));
  const finite = (x: unknown): boolean =>
    typeof x === 'number'
      ? Number.isFinite(x)
      : Array.isArray(x)
        ? x.every(finite)
        : x !== null && typeof x === 'object'
          ? Object.values(x).every(finite)
          : true;
  if (!finite(input)) throw new Error('All numeric inputs must be finite.');
}
