/**
 * 手写严格 JSON 解析器。
 *
 * `JSON.parse` 既不报重复键也不报尾随内容，而协议要求重复键、超长行、截断帧
 * 永远不能当作成功解析。这里实现一个有界解析器：重复键、尾随内容、深度超限、
 * 非法转义都直接抛 `StrictJsonError`。
 */

import { MAX_JSON_DEPTH } from "./limits.js";

export class StrictJsonError extends Error {
  /**
   * @param {string} reason 稳定的机器可读原因
   * @param {number} [offset] 字符串内的字符偏移
   */
  constructor(reason, offset = -1) {
    super(`${reason} at ${offset}`);
    this.name = "StrictJsonError";
    this.reason = reason;
    this.offset = offset;
  }
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/;

class StrictJsonParser {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new StrictJsonError("trailing_content", this.index);
    return value;
  }

  skipWhitespace() {
    while (this.index < this.text.length && WHITESPACE.has(this.text[this.index])) this.index += 1;
  }

  parseValue(depth) {
    if (depth > MAX_JSON_DEPTH) throw new StrictJsonError("max_depth_exceeded", this.index);
    const char = this.text[this.index];
    if (char === undefined) throw new StrictJsonError("unexpected_end", this.index);
    if (char === "{") return this.parseObject(depth);
    if (char === "[") return this.parseArray(depth);
    if (char === '"') return this.parseString();
    if (char === "t") return this.parseLiteral("true", true);
    if (char === "f") return this.parseLiteral("false", false);
    if (char === "n") return this.parseLiteral("null", null);
    if (char === "-" || (char >= "0" && char <= "9")) return this.parseNumber();
    throw new StrictJsonError("unexpected_token", this.index);
  }

  parseObject(depth) {
    this.index += 1;
    /** @type {Record<string, unknown>} */
    const result = {};
    /** @type {Set<string>} */
    const seen = new Set();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') throw new StrictJsonError("expected_key", this.index);
      const key = this.parseString();
      // 重复键必须失败：Helper 侧与 producer 侧对同一个帧的解读必须唯一。
      if (seen.has(key)) throw new StrictJsonError("duplicate_key", this.index);
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") throw new StrictJsonError("expected_colon", this.index);
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const char = this.text[this.index];
      if (char === ",") {
        this.index += 1;
        continue;
      }
      if (char === "}") {
        this.index += 1;
        return result;
      }
      throw new StrictJsonError("expected_comma_or_brace", this.index);
    }
  }

  parseArray(depth) {
    this.index += 1;
    /** @type {unknown[]} */
    const result = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const char = this.text[this.index];
      if (char === ",") {
        this.index += 1;
        continue;
      }
      if (char === "]") {
        this.index += 1;
        return result;
      }
      throw new StrictJsonError("expected_comma_or_bracket", this.index);
    }
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    let out = "";
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) throw new StrictJsonError("unterminated_string", start);
      if (char === '"') {
        this.index += 1;
        return out;
      }
      if (char === "\\") {
        this.index += 1;
        out += this.parseEscape();
        continue;
      }
      // 未转义的 LF/CR 在 JSON 字符串里非法，NDJSON 帧不允许原始换行。
      if (char === "\n" || char === "\r")
        throw new StrictJsonError("control_char_in_string", this.index);
      out += char;
      this.index += 1;
    }
  }

  parseEscape() {
    const char = this.text[this.index];
    this.index += 1;
    switch (char) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex))
          throw new StrictJsonError("bad_unicode_escape", this.index);
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw new StrictJsonError("bad_escape", this.index - 1);
    }
  }

  parseNumber() {
    const match = NUMBER_PATTERN.exec(this.text.slice(this.index));
    if (!match) throw new StrictJsonError("bad_number", this.index);
    this.index += match[0].length;
    return Number(match[0]);
  }

  parseLiteral(word, value) {
    if (this.text.slice(this.index, this.index + word.length) !== word) {
      throw new StrictJsonError("bad_literal", this.index);
    }
    this.index += word.length;
    return value;
  }
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseStrictJson(text) {
  if (typeof text !== "string" || text.length === 0) {
    throw new StrictJsonError("empty_input", 0);
  }
  return new StrictJsonParser(text).parse();
}
