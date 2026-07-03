/**
 * Shared code-expression builders used by the credential transformers. Kept
 * separate so the transformation of a resolved base expression (a literal
 * `'locked_out_user'` or a data binding `user.username ?? ''`) into its mutated
 * form is defined once and reused.
 */

/**
 * Wrap a resolved username expression so it carries a leading AND trailing space
 * (leading/trailing-whitespace scenario), keeping the value data-driven:
 *   - literal  'locked_out_user'      → ' locked_out_user '
 *   - expression user.username ?? ''  → ` ${user.username ?? ''} `
 */
export function wrapWhitespace(baseExpr: string): string {
  const lit = baseExpr.match(/^'(.*)'$/);
  if (lit) return `' ${lit[1]} '`;
  return '`' + ' ${' + baseExpr + '} ' + '`';
}

/**
 * Prepend a special character to a resolved username expression when the case
 * did not author an explicit special-character value:
 *   - literal  'locked_out_user'      → '@locked_out_user'
 *   - expression user.username ?? ''  → `@${user.username ?? ''}`
 */
export function prependSpecialChar(baseExpr: string): string {
  const lit = baseExpr.match(/^'(.*)'$/);
  if (lit) return `'@${lit[1]}'`;
  return '`@${' + baseExpr + '}`';
}
