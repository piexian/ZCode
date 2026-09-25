/**
 * 严格手写校验器。
 *
 * 组合子返回 `(value, path, issues) => T | FAIL`：成功时返回归一化后的值（可写入默认值、
 * clamp 后的数值），失败时写一条 issue 并返回 `FAIL`。所有 object 校验默认 strict，
 * 未知键就是失败，模型无法通过多余键改变 producer 行为。
 */

/** 校验失败的哨兵；schema 不会把它当成合法值返回。 */
export const FAIL = Symbol("cua.validation.fail");

/**
 * @typedef {{path: string, message: string}} ValidationIssue
 * @typedef {(value: unknown, path: string, issues: ValidationIssue[]) => unknown} Schema
 * @typedef {{schema: Schema, required?: boolean, default?: unknown}} FieldSpec
 */

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {Schema} schema
 * @param {unknown} value
 * @returns {{ok: true, value: unknown} | {ok: false, issues: ValidationIssue[]}}
 */
export function validate(schema, value) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  const out = schema(value, "$", issues);
  if (out === FAIL) return { ok: false, issues };
  return { ok: true, value: out };
}

export function fail(issues, path, message) {
  issues.push({ path, message });
  return FAIL;
}

/** @param {string} path @param {string} key */
export const childPath = (path, key) => `${path}.${key}`;

/**
 * strict object：`fields` 之外的键一律拒绝。字段值可以是裸 Schema，也可以是
 * `{ schema, required, default }` 描述符。
 *
 * @param {Record<string, Schema | FieldSpec>} fields
 * @returns {Schema}
 */
export function strictObject(fields) {
  return (value, path, issues) => {
    if (!isPlainObject(value)) return fail(issues, path, "expected object");
    const source = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(source)) {
      if (!Object.hasOwn(fields, key)) {
        issues.push({ path: childPath(path, key), message: "unknown field" });
      }
    }
    for (const [key, descriptor] of Object.entries(fields)) {
      const spec = typeof descriptor === "function" ? { schema: descriptor } : descriptor;
      const raw = source[key];
      if (raw === undefined) {
        if (spec.default !== undefined) {
          out[key] = spec.default;
        } else if (spec.required) {
          issues.push({ path: childPath(path, key), message: "required field is missing" });
        }
        continue;
      }
      const parsed = spec.schema(raw, childPath(path, key), issues);
      if (parsed !== FAIL) out[key] = parsed;
    }
    return issues.length > 0 ? FAIL : out;
  };
}

/**
 * @param {{minLength?: number, maxLength?: number}} [options]
 * @returns {Schema}
 */
export const string =
  (options = {}) =>
  (value, path, issues) => {
    if (typeof value !== "string") return fail(issues, path, "expected string");
    if (options.minLength !== undefined && value.length < options.minLength) {
      return fail(issues, path, `string shorter than ${options.minLength}`);
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      return fail(issues, path, `string longer than ${options.maxLength}`);
    }
    return value;
  };

/**
 * 非空标识串：app_ref 字符串、frame_id、action 名称等。
 * @param {{maxLength?: number}} [options]
 * @returns {Schema}
 */
export const nonEmptyString = (options = {}) => string({ minLength: 1, ...options });

/**
 * @param {{min?: number, max?: number, clamp?: boolean|"max"}} [options]
 * @returns {Schema}
 */
export const integer =
  (options = {}) =>
  (value, path, issues) => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return fail(issues, path, "expected integer");
    }
    if (options.min !== undefined && value < options.min) {
      return options.clamp === true
        ? options.min
        : fail(issues, path, `integer below ${options.min}`);
    }
    if (options.max !== undefined && value > options.max) {
      return options.clamp ? options.max : fail(issues, path, `integer above ${options.max}`);
    }
    return value;
  };

/**
 * @param {{min?: number, max?: number, clamp?: boolean|"max"}} [options]
 * @returns {Schema}
 */
export const number =
  (options = {}) =>
  (value, path, issues) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail(issues, path, "expected finite number");
    }
    if (options.min !== undefined && value < options.min) {
      return options.clamp === true
        ? options.min
        : fail(issues, path, `number below ${options.min}`);
    }
    if (options.max !== undefined && value > options.max) {
      return options.clamp ? options.max : fail(issues, path, `number above ${options.max}`);
    }
    return value;
  };

/** @returns {Schema} */
export const boolean = () => (value, path, issues) => {
  if (typeof value !== "boolean") return fail(issues, path, "expected boolean");
  return value;
};

/**
 * @param {readonly string[]} values
 * @returns {Schema}
 */
export const enumOf = (values) => (value, path, issues) => {
  if (typeof value !== "string" || !values.includes(value)) {
    return fail(issues, path, `expected one of ${values.join("|")}`);
  }
  return value;
};

/**
 * @param {Schema} item
 * @param {{minItems?: number, maxItems?: number, exactItems?: number}} [options]
 * @returns {Schema}
 */
export const arrayOf =
  (item, options = {}) =>
  (value, path, issues) => {
    if (!Array.isArray(value)) return fail(issues, path, "expected array");
    if (options.exactItems !== undefined && value.length !== options.exactItems) {
      return fail(issues, path, `expected ${options.exactItems} items`);
    }
    if (options.minItems !== undefined && value.length < options.minItems) {
      return fail(issues, path, `array shorter than ${options.minItems}`);
    }
    if (options.maxItems !== undefined && value.length > options.maxItems) {
      return fail(issues, path, `array longer than ${options.maxItems}`);
    }
    const out = [];
    let bad = false;
    value.forEach((entry, index) => {
      const parsed = item(entry, `${path}[${index}]`, issues);
      if (parsed === FAIL) bad = true;
      else out.push(parsed);
    });
    return bad ? FAIL : out;
  };

/**
 * @param {Schema[]} schemas
 * @returns {Schema}
 */
export const union = (schemas) => (value, path, issues) => {
  /** @type {ValidationIssue[]} */
  const branchIssues = [];
  for (const schema of schemas) {
    branchIssues.length = 0;
    const parsed = schema(value, path, branchIssues);
    if (parsed !== FAIL) return parsed;
  }
  issues.push({
    path,
    message: `no union branch matched: ${branchIssues.map((issue) => issue.message).join("; ")}`,
  });
  return FAIL;
};

/**
 * @param {unknown} expected
 * @returns {Schema}
 */
export const literal = (expected) => (value, path, issues) => {
  if (value !== expected) return fail(issues, path, `expected ${JSON.stringify(expected)}`);
  return value;
};
